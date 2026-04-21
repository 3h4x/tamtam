import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath, clearProjectDataCache } from './project-data';
import { exec } from './shell';
import { getSettings } from './config';
import { getImproveConfig, setProjectPushResult } from './scheduling';
import { buildDiffContext } from './diff-context';
import { createJob, markDone, updateJob, listJobs } from './job-storage';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';

export type CommitResult =
  | { ok: true; commitSha: string; message: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string };

// Matches any conventional commit title with a non-trivial description (3+ chars).
const CONV_RE = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\(.+?\))?:\s*.{3,}/i;
// Generic fallback phrases the model produces when it lacks real diff context.
const GENERIC_RE = /^chore:\s*(automated?\s*update|update|changes?)$/i;

export async function generateCommitMessage(projPath: string, projectName: string): Promise<string> {
  const [statR, diffR] = await Promise.all([
    exec('git', ['-C', projPath, 'diff', '--cached', '--stat', '--no-color'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'diff', '--cached', '--no-color'], { timeout: 10000 }),
  ]);

  const { context } = buildDiffContext(statR.stdout, diffR.stdout);
  const styleGuide = (getSettings().commit_style ?? '').trim();

  const buildPrompt = (extra = '') =>
    `Output exactly one conventional commit title. No prose, no code blocks, no backticks, no quotes.

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
${styleGuide ? `\nSTYLE GUIDE:\n${styleGuide}\n` : ''}
Return ONLY the title — nothing else.${extra}`;

  const { claudeBin } = getImproveConfig();

  // --system-prompt replaces the injected CLAUDE.md/git-history system prompt so the
  // model cannot pattern-match on recent "chore: automated update" commits.
  // --tools "" prevents the model from running git commands itself instead of using
  // the diff context we embed in the user prompt.
  const claudeArgs = (prompt: string) => [
    '--print', '--tools', '', '--system-prompt',
    'You are a commit message generator. Output only what is requested. Do not add prose or explanation.',
    '--model', 'haiku', '-p', prompt,
  ];

  const parse = (stdout: string): string => {
    const cleaned = stdout
      .trim()
      .split('\n')
      .map((l) => l.replace(/^[`'"*_\d.)\-•\s]+/, '').replace(/[`'"*_]+$/, '').trim())
      .filter(Boolean);
    // Prefer a specific conventional title; skip generic ones on first pass.
    return (
      cleaned.find((l) => CONV_RE.test(l) && !GENERIC_RE.test(l)) ??
      cleaned.find((l) => CONV_RE.test(l)) ??
      cleaned[0] ??
      ''
    );
  };

  const r1 = await exec(claudeBin, claudeArgs(buildPrompt()), { cwd: projPath, timeout: 30000 });
  const msg1 = parse(r1.stdout);

  // If the first attempt returns a generic placeholder, retry once with an explicit nudge.
  if (!msg1 || GENERIC_RE.test(msg1)) {
    const r2 = await exec(
      claudeBin,
      claudeArgs(buildPrompt('\n\nIMPORTANT: Be specific about what actually changed in the diff above. Do not use generic descriptions like "automated update".')),
      { cwd: projPath, timeout: 30000 },
    );
    const msg2 = parse(r2.stdout);
    if (msg2 && !GENERIC_RE.test(msg2)) return msg2;
  }

  // Both attempts were generic or empty — derive a specific fallback from the stat.
  if (!msg1 || GENERIC_RE.test(msg1)) {
    const fileNames = statR.stdout.trim().split('\n')
      .filter(l => l.includes('|'))
      .map(l => l.split('|')[0].trim())
      .filter(Boolean);
    if (fileNames.length > 0) {
      return `chore: update ${fileNames.slice(0, 3).join(', ')}`;
    }
  }

  return msg1 || 'chore: update files';
}

export function issueBranchName(issue: { number: number; title: string }): string {
  const slugTitle = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `fix/issue-${issue.number}${slugTitle ? `-${slugTitle}` : ''}`;
}

export async function findIssueContext(
  projectName: string,
  projPath: string,
): Promise<{ number: number; repo: string; title: string } | null> {
  const jobs = listJobs()
    .filter(j => j.project === projectName && j.kind === 'run' && j.ghIssueNumber != null)
    .sort((a, b) => b.startedAt - a.startedAt);
  const job = jobs[0];
  if (!job || job.ghIssueNumber == null) return null;
  const repo = job.ghIssueRepo ?? '';
  // Skip already-closed issues — otherwise the next release after an
  // issue-driven merge creates a redundant PR targeting the closed issue
  // (the run job keeps the gh_issue_number stamp forever).
  if (repo) {
    try {
      const r = await exec('gh', ['issue', 'view', String(job.ghIssueNumber), '--repo', repo, '--json', 'state'], { cwd: projPath, timeout: 10000 });
      if (r.exitCode === 0) {
        const state = (JSON.parse(r.stdout).state ?? '').toString().toUpperCase();
        if (state && state !== 'OPEN') return null;
      }
    } catch {
      // gh unreachable — fall through and use the context optimistically.
    }
  }
  return { number: job.ghIssueNumber, repo, title: job.ghIssueTitle ?? '' };
}

export async function detectMainBranch(projPath: string): Promise<string> {
  const r = await exec('git', ['-C', projPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5000 });
  if (r.exitCode === 0) {
    const match = r.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1];
  }
  // Fallback: check if 'main' or 'master' exists
  const mainR = await exec('git', ['-C', projPath, 'rev-parse', '--verify', 'main'], { timeout: 3000 });
  return mainR.exitCode === 0 ? 'main' : 'master';
}

async function runCommit(
  projectName: string,
  projPath: string,
  log: (s: string) => void,
  issueCtx?: { number: number; repo: string; title: string } | null,
): Promise<CommitResult> {
  // If we have issue context and are currently on the default branch, switch
  // to a feature branch BEFORE committing. Otherwise the commit lands on main,
  // the subsequent PR attempt produces an empty diff, and GH rejects it.
  if (issueCtx === undefined) issueCtx = await findIssueContext(projectName, projPath);
  if (issueCtx) {
    const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
    const currentBranch = branchR.stdout.trim();
    const mainBranch = await detectMainBranch(projPath);
    if (!currentBranch || currentBranch === mainBranch) {
      const featureBranch = issueBranchName(issueCtx);
      log(`\n# on ${currentBranch || '(detached)'} — switching to ${featureBranch} before commit\n`);
      const coR = await exec('git', ['-C', projPath, 'checkout', '-b', featureBranch], { timeout: 10000 });
      if (coR.stdout) log(coR.stdout);
      if (coR.stderr) log(coR.stderr);
      if (coR.exitCode !== 0) {
        // Branch may already exist — try checking out existing
        const coExistingR = await exec('git', ['-C', projPath, 'checkout', featureBranch], { timeout: 10000 });
        if (coExistingR.stdout) log(coExistingR.stdout);
        if (coExistingR.stderr) log(coExistingR.stderr);
        if (coExistingR.exitCode !== 0) {
          return { ok: false, status: 500, detail: `Failed to create issue branch ${featureBranch}: ${coR.stderr || coR.stdout}` };
        }
      }
    }
  }

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
    let commitR = await exec('git', ['-C', projPath, 'commit', '-m', message], { timeout: 30000 });
    if (commitR.stdout) log(commitR.stdout);
    if (commitR.stderr) log(commitR.stderr);
    // Pre-commit hook may have modified files, causing the commit to abort.
    // Stage the hook's changes and retry once so the hook's work is included.
    if (commitR.exitCode !== 0 && !commitR.stdout.includes('nothing to commit')) {
      const hookChangesR = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
      if (hookChangesR.stdout.trim()) {
        log(`\n# pre-commit hook modified files — staging and retrying commit\n`);
        await exec('git', ['-C', projPath, 'add', '-A'], { timeout: 10000 });
        commitR = await exec('git', ['-C', projPath, 'commit', '-m', message], { timeout: 30000 });
        if (commitR.stdout) log(commitR.stdout);
        if (commitR.stderr) log(commitR.stderr);
      }
    }
    if (commitR.exitCode !== 0 && !commitR.stdout.includes('nothing to commit')) {
      const detail = (commitR.stderr.trim() || commitR.stdout.trim() || `git commit exited ${commitR.exitCode}`).slice(0, 2000);
      return { ok: false, status: 500, detail: `Commit failed: ${detail}` };
    }
    const shaR = await exec('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
    return { ok: true, commitSha: shaR.exitCode === 0 ? shaR.stdout.trim() : '', message: 'committed' };
  } else {
    const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
    log(`\n$ git rev-list --count @{u}..HEAD\n${aheadR.stdout}`);
    const ahead = parseInt(aheadR.stdout.trim(), 10);
    if (!aheadR.stdout.trim() || aheadR.exitCode !== 0 || isNaN(ahead) || ahead === 0) {
      return { ok: true, commitSha: '', message: 'Nothing to commit' };
    }
    return { ok: true, commitSha: '', message: 'Nothing to commit (already ahead)' };
  }
}

export async function startProjectCommit(projectName: string): Promise<CommitResult> {
  // Check for existing pipeline lock — but allow running under a parent
  // release job's lock (this step was kicked off by the release pipeline).
  const underRelease = isLockOwnedByActiveRelease(projectName);
  if (!underRelease) {
    const lock = getLock(projectName);
    if (lock) {
      setProjectPushResult(projectName, `Pipeline is running for ${projectName}`);
      return { ok: false, status: 409, detail: `Pipeline is running for ${projectName}`, blockingJobId: lock.lockedByJobId };
    }
  }

  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    setProjectPushResult(projectName, 'project not found');
    return { ok: false, status: 404, detail: 'project not found' };
  }

  const { logDir } = getImproveConfig();
  mkdirSync(logDir, { recursive: true });
  // Stamp issue context on the commit job so downstream hooks can pick it up.
  const earlyIssueCtx = await findIssueContext(projectName, projPath);
  const job = createJob(
    projectName, 'commit', process.pid, '',
    undefined, undefined, undefined,
    earlyIssueCtx?.number ?? null,
    earlyIssueCtx?.repo ?? null,
    earlyIssueCtx?.title ?? null,
  );
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);

  // Acquire pipeline lock — skip under parent release lock.
  if (!underRelease) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-commit] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  const append = (s: string) => {
    try { appendFileSync(logPath, s); } catch {}
  };
  append(`# commit start — ${new Date().toISOString()}\n# repo: ${projPath}\n`);

  const result = await runCommit(projectName, projPath, append, earlyIssueCtx);
  try {
    setProjectPushResult(projectName, result.ok ? null : result.detail);
  } catch {}
  if (result.ok) {
    clearProjectDataCache();
    append(`\n# commit ok — ${'commitSha' in result && result.commitSha ? result.commitSha : 'no-op'}\n${result.message}\n`);
  } else {
    append(`\n# commit failed (${result.status})\n${result.detail}\n`);
  }

  await markDone(job, result.ok ? 0 : 1);
  return result;
}
