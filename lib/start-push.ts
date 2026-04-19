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
    // Use --no-verify to bypass pre-commit hooks. Quality gates live in
    // pre-push hooks (or the AI review step upstream). Pre-commit hooks that
    // modify files would abort the commit and leave us stuck.
    log(`# commit message: ${message}\n\n$ git commit --no-verify -m "${message}"\n`);
    const commitR = await exec('git', ['-C', projPath, 'commit', '--no-verify', '-m', message], { timeout: 30000 });
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

  const tryPush = async (extraArgs: string[] = []): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const args = ['-C', projPath, 'push', ...extraArgs];
    log(`\n$ git push${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}\n`);
    const r = await exec('git', args, { timeout: 30000 });
    if (r.stdout) log(r.stdout);
    if (r.stderr) log(r.stderr);
    return r;
  };

  // Auto-rebase if behind remote to prevent non-fast-forward rejection
  const branchStatusR = await exec('git', ['-C', projPath, 'status', '--porcelain=v2', '--branch'], { timeout: 5000 });
  const abLine = branchStatusR.stdout.split('\n').find(l => l.startsWith('# branch.ab '));
  const behind = abLine ? parseInt(abLine.match(/-(\d+)/)?.[1] ?? '0', 10) : 0;
  if (behind > 0) {
    log(`\n# ${behind} commit(s) behind remote — rebasing before push\n`);
    const rebaseR = await exec('git', ['-C', projPath, 'pull', '--rebase'], { timeout: 60000 });
    if (rebaseR.stdout) log(rebaseR.stdout);
    if (rebaseR.stderr) log(rebaseR.stderr);
    if (rebaseR.exitCode !== 0) {
      const detail = (rebaseR.stderr.trim() || rebaseR.stdout.trim() || 'rebase failed').slice(0, 2000);
      return { ok: false, status: 409, detail: `Rebase failed before push: ${detail}` };
    }
    log(`\n# rebase succeeded\n`);
  }

  let pushR = await tryPush();

  // If no upstream branch is set, detect current branch and set it.
  if (pushR.exitCode !== 0 && (pushR.stderr.includes('no upstream') || pushR.stderr.includes('set-upstream'))) {
    const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
    const branch = branchR.stdout.trim();
    if (branch) pushR = await tryPush(['-u', 'origin', branch]);
  }

  // Pre-push hook may have left new uncommitted changes on disk.
  // Stage and commit just those changes ("revisiting just new changes"), then retry once.
  if (pushR.exitCode !== 0) {
    const hookChangesR = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
    const hookHasChanges = !!hookChangesR.stdout.trim();
    if (hookHasChanges) {
      log(`\n# pre-push hook left new changes — committing delta\n`);
      await exec('git', ['-C', projPath, 'add', '-A'], { timeout: 10000 });
      const fixMsg = await generateCommitMessage(projPath, projectName);
      log(`# fix commit message: ${fixMsg}\n\n$ git commit --no-verify -m "${fixMsg}"\n`);
      const fixCommitR = await exec('git', ['-C', projPath, 'commit', '--no-verify', '-m', fixMsg], { timeout: 30000 });
      if (fixCommitR.stdout) log(fixCommitR.stdout);
      if (fixCommitR.stderr) log(fixCommitR.stderr);
      if (fixCommitR.exitCode === 0 || fixCommitR.stdout.includes('nothing to commit')) {
        log(`\n# retrying push after hook fix commit\n`);
        pushR = await tryPush();
      }
    }
  }

  if (pushR.exitCode !== 0) {
    const detail = (pushR.stderr.trim() || pushR.stdout.trim() || `git push exited ${pushR.exitCode}`).slice(0, 2000);
    return { ok: false, status: 502, detail: `Push failed: ${detail}` };
  }

  const shaR = await exec('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
  const commitSha = shaR.exitCode === 0 ? shaR.stdout.trim() : '';

  return { ok: true, commitSha, message: 'pushed' };
}
