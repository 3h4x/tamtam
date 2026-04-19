import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath, clearProjectDataCache } from './project-data';
import { invalidateProject } from './gh-status';
import { exec } from './shell';
import { getSettings } from './config';
import { getImproveConfig, setProjectPushResult } from './scheduling';
import { buildDiffContext } from './diff-context';
import { createJob, markDone, updateJob } from './job-storage';

export type PushResult =
  | { ok: true; commitSha: string; message: string }
  | { ok: false; status: number; detail: string };

async function generateCommitMessage(projPath: string, projectName: string): Promise<string> {
  const [statR, diffR] = await Promise.all([
    exec('git', ['-C', projPath, 'diff', '--cached', '--stat', '--no-color'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'diff', '--cached', '--no-color'], { timeout: 10000 }),
  ]);

  const { context } = buildDiffContext(statR.stdout, diffR.stdout);
  const styleGuide = (getSettings().commit_style ?? '').trim();
  const prompt = `Output exactly one conventional commit title. No prose, no code blocks, no backticks, no quotes.

Use the format: <type>(<optional scope>): <description>
Types: feat, fix, refactor, chore, docs, test, style, perf, ci, build

Analyze the diff to determine the correct type:
- feat: new capability or behavior added
- fix: corrects broken/incorrect behavior
- refactor: restructures code without changing behavior
- chore: tooling, config, dependencies, maintenance
- docs: documentation only
- test: adds or updates tests

Repository: ${projectName}
${context}

${styleGuide ? `STYLE GUIDE:\n${styleGuide}\n` : ''}
Return ONLY the title — nothing else.`;

  const { claudeBin } = getImproveConfig();
  const result = await exec(claudeBin, ['--print', '--model', 'haiku', '-p', prompt], {
    cwd: projPath,
    timeout: 30000,
  });
  const line = result.stdout.trim().split('\n')[0] ?? '';
  return line.replace(/^[`'"*_]+/, '').replace(/[`'"*_]+$/, '').trim() || 'chore: automated update';
}

export async function startProjectPush(projectName: string): Promise<PushResult> {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    setProjectPushResult(projectName, 'project not found');
    return { ok: false, status: 404, detail: 'project not found' };
  }

  // Track every push attempt as a job so it appears in /runs with a log file
  // the user can inspect — same pattern as tests/review.
  const { logDir } = getImproveConfig();
  mkdirSync(logDir, { recursive: true });
  const job = createJob(projectName, 'push', process.pid, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);

  const append = (s: string) => {
    try { appendFileSync(logPath, s); } catch {}
  };
  append(`# push start — ${new Date().toISOString()}\n# repo: ${projPath}\n`);

  const result = await runPush(projectName, projPath, append);
  try {
    setProjectPushResult(projectName, result.ok ? null : result.detail);
  } catch {}
  if (result.ok) {
    invalidateProject(projectName);
    clearProjectDataCache();
    append(`\n# push ok — ${'commitSha' in result && result.commitSha ? result.commitSha : 'no-op'}\n${result.message}\n`);
  } else {
    append(`\n# push failed (${result.status})\n${result.detail}\n`);
  }

  await markDone(job, result.ok ? 0 : 1);
  return result;
}

async function runPush(
  projectName: string,
  projPath: string,
  log: (s: string) => void,
): Promise<PushResult> {
  // Stage all changes including new (untracked) files. .gitignore is expected
  // to exclude secrets — auto-push trusts it.
  log(`\n$ git add -A\n`);
  const addR = await exec('git', ['-C', projPath, 'add', '-A'], { timeout: 10000 });
  if (addR.stdout) log(addR.stdout);
  if (addR.stderr) log(addR.stderr);
  const statusR = await exec('git', ['-C', projPath, 'diff', '--cached', '--name-status'], { timeout: 10000 });
  log(`\n$ git diff --cached --name-status\n${statusR.stdout}`);
  const hasStaged = !!statusR.stdout.trim();

  if (hasStaged) {
    log(`\n# generating commit message via Claude...\n`);
    const message = await generateCommitMessage(projPath, projectName);
    log(`# commit message: ${message}\n\n$ git commit -m "${message}"\n`);
    const commitR = await exec('git', ['-C', projPath, 'commit', '-m', message], { timeout: 30000 });
    if (commitR.stdout) log(commitR.stdout);
    if (commitR.stderr) log(commitR.stderr);
    if (commitR.exitCode !== 0 && !commitR.stdout.includes('nothing to commit')) {
      const detail = (commitR.stderr.trim() || commitR.stdout.trim() || `git commit exited ${commitR.exitCode}`).slice(0, 2000);
      return { ok: false, status: 500, detail: `Commit failed: ${detail}` };
    }
  } else {
    const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
    log(`\n$ git rev-list --count @{u}..HEAD\n${aheadR.stdout}`);
    const ahead = parseInt(aheadR.stdout.trim(), 10);
    if (!aheadR.stdout.trim() || aheadR.exitCode !== 0 || isNaN(ahead) || ahead === 0) {
      return { ok: true, commitSha: '', message: 'No changes to push' };
    }
  }

  log(`\n$ git push\n`);
  let pushR = await exec('git', ['-C', projPath, 'push'], { timeout: 30000 });
  if (pushR.stdout) log(pushR.stdout);
  if (pushR.stderr) log(pushR.stderr);
  if (pushR.exitCode !== 0) {
    if (pushR.stderr.includes('no upstream') || pushR.stderr.includes('set-upstream')) {
      const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
      const branch = branchR.stdout.trim();
      if (branch) {
        log(`\n$ git push -u origin ${branch}\n`);
        pushR = await exec('git', ['-C', projPath, 'push', '-u', 'origin', branch], { timeout: 30000 });
        if (pushR.stdout) log(pushR.stdout);
        if (pushR.stderr) log(pushR.stderr);
      }
    }
    if (pushR.exitCode !== 0) {
      const detail = (pushR.stderr.trim() || pushR.stdout.trim() || `git push exited ${pushR.exitCode}`).slice(0, 2000);
      return { ok: false, status: 502, detail: `Push failed: ${detail}` };
    }
  }

  const shaR = await exec('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
  const commitSha = shaR.exitCode === 0 ? shaR.stdout.trim() : '';

  return { ok: true, commitSha, message: 'pushed' };
}
