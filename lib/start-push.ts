import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath, clearProjectDataCache } from './project-data';
import { invalidateProject } from './gh-status';
import { exec } from './shell';
import { getSettings } from './config';
import { getImproveConfig, setProjectPushResult, getProjectTestConfig } from './scheduling';
import { buildDiffContext } from './diff-context';
import { createJob, markDone, updateJob, listJobs } from './job-storage';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';

export type PushResult =
  | { ok: true; commitSha: string; message: string; prUrl?: string }
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

export async function startProjectPush(projectName: string, opts: { commitOnly?: boolean } = {}): Promise<PushResult> {
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

  // Track every push attempt as a job so it appears in /runs with a log file
  // the user can inspect — same pattern as tests/review.
  const { logDir } = getImproveConfig();
  mkdirSync(logDir, { recursive: true });
  const job = createJob(projectName, 'push', process.pid, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);

  // Acquire pipeline lock — skip under parent release lock.
  if (!underRelease) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-push] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  const append = (s: string) => {
    try { appendFileSync(logPath, s); } catch {}
  };
  append(`# push start — ${new Date().toISOString()}\n# repo: ${projPath}\n`);

  const result = await runPush(projectName, projPath, append, opts);
  try {
    setProjectPushResult(projectName, result.ok ? null : result.detail);
  } catch {}
  if (result.ok) {
    if (result.prUrl) {
      job.contextMeta = JSON.stringify({ prUrl: result.prUrl });
      updateJob(job);
    }
    invalidateProject(projectName);
    clearProjectDataCache();
    append(`\n# push ok — ${'commitSha' in result && result.commitSha ? result.commitSha : 'no-op'}\n${result.message}\n`);
  } else {
    append(`\n# push failed (${result.status})\n${result.detail}\n`);
  }

  await markDone(job, result.ok ? 0 : 1);
  return result;
}

// Fire-and-forget variant: creates the job synchronously, runs push in the
// background, and returns the job ID immediately so callers can stream output.
export function launchProjectPush(projectName: string): { jobId: string } | { error: string } {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { error: 'project not found' };

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

  // Run async in background — do not await
  ;(async () => {
    // Acquire pipeline lock — skip under parent release lock.
    if (!isLockOwnedByActiveRelease(projectName)) {
      try {
        await acquireLock(projectName, job.id);
      } catch (e) {
        console.log(`[launch-push] failed to acquire pipeline lock for ${projectName}:`, e);
      }
    }

    const result = await runPush(projectName, projPath, append);
    try { setProjectPushResult(projectName, result.ok ? null : result.detail); } catch {}
    if (result.ok) {
      invalidateProject(projectName);
      clearProjectDataCache();
      append(`\n# push ok — ${'commitSha' in result && result.commitSha ? result.commitSha : 'no-op'}\n${result.message}\n`);
    } else {
      append(`\n# push failed (${result.status})\n${result.detail}\n`);
    }
    await markDone(job, result.ok ? 0 : 1);
  })();

  return { jobId: job.id };
}

function findIssueContext(projectName: string): { number: number; repo: string; title: string } | null {
  const jobs = listJobs()
    .filter(j => j.project === projectName && j.kind === 'run' && j.ghIssueNumber != null)
    .sort((a, b) => b.startedAt - a.startedAt);
  const job = jobs[0];
  if (!job || job.ghIssueNumber == null) return null;
  return { number: job.ghIssueNumber, repo: job.ghIssueRepo ?? '', title: job.ghIssueTitle ?? '' };
}

async function runPush(
  projectName: string,
  projPath: string,
  log: (s: string) => void,
  opts: { commitOnly?: boolean } = {},
): Promise<PushResult> {
  // If we have issue context or PR pipeline mode is on, ensure we're on a
  // feature branch BEFORE committing. Otherwise the commit lands on main,
  // the subsequent PR attempt produces an empty diff, and GH rejects it.
  const issueCtx = findIssueContext(projectName);
  const projectConfig = getProjectTestConfig(projectName);
  // PR pipeline only applies when there's no issue context (issue context has its own branch logic)
  const prPipeline = !issueCtx && (projectConfig?.prPipeline ?? false);

  if (issueCtx || prPipeline) {
    const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
    const currentBranch = branchR.stdout.trim();
    const mainBranch = await detectMainBranch(projPath);
    if (!currentBranch || currentBranch === mainBranch) {
      const featureBranch = issueCtx ? issueBranchName(issueCtx) : prPipelineBranchName();
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
          return { ok: false, status: 500, detail: `Failed to create feature branch ${featureBranch}: ${coR.stderr || coR.stdout}` };
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
    if (opts.commitOnly) {
      const shaR = await exec('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
      return { ok: true, commitSha: shaR.exitCode === 0 ? shaR.stdout.trim() : '', message: 'committed (push skipped)' };
    }
  } else {
    const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
    log(`\n$ git rev-list --count @{u}..HEAD\n${aheadR.stdout}`);
    const ahead = parseInt(aheadR.stdout.trim(), 10);
    if (!aheadR.stdout.trim() || aheadR.exitCode !== 0 || isNaN(ahead) || ahead === 0) {
      return { ok: true, commitSha: '', message: opts.commitOnly ? 'Nothing to commit' : 'No changes to push' };
    }
    if (opts.commitOnly) {
      return { ok: true, commitSha: '', message: 'committed (push skipped)' };
    }
  }

  // Pre-push hooks (e.g. borged's full CI pipeline) can take 15-20 minutes.
  // killProcessGroup ensures the entire hook process tree (check.ts + vitest workers)
  // is killed if the timeout fires, preventing orphaned workers.
  const PUSH_TIMEOUT = 25 * 60 * 1000; // 25 minutes

  const tryPush = async (extraArgs: string[] = []): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const args = ['-C', projPath, 'push', ...extraArgs];
    log(`\n$ git push${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}\n`);
    const r = await exec('git', args, { timeout: PUSH_TIMEOUT, killProcessGroup: true });
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
    const rebaseR = await exec('git', ['-C', projPath, 'pull', '--rebase'], { timeout: PUSH_TIMEOUT, killProcessGroup: true });
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

  // Push rejected because the remote has commits the local clone doesn't know about
  // (stale tracking info — the pre-push behind-check missed it). Pull --rebase and retry.
  if (pushR.exitCode !== 0 && (pushR.stderr.includes('fetch first') || pushR.stderr.includes('Updates were rejected'))) {
    log(`\n# remote has new commits (stale tracking) — rebasing before retry\n`);
    const rebaseR = await exec('git', ['-C', projPath, 'pull', '--rebase'], { timeout: PUSH_TIMEOUT, killProcessGroup: true });
    if (rebaseR.stdout) log(rebaseR.stdout);
    if (rebaseR.stderr) log(rebaseR.stderr);
    if (rebaseR.exitCode === 0) {
      log(`\n# rebase succeeded — retrying push\n`);
      pushR = await tryPush();
    } else {
      const detail = (rebaseR.stderr.trim() || rebaseR.stdout.trim() || 'rebase failed').slice(0, 2000);
      return { ok: false, status: 409, detail: `Rebase failed before push: ${detail}` };
    }
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
      log(`# fix commit message: ${fixMsg}\n\n$ git commit -m "${fixMsg}"\n`);
      const fixCommitR = await exec('git', ['-C', projPath, 'commit', '-m', fixMsg], { timeout: 30000 });
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

  // If this session was started from a GitHub issue, create a PR that closes it
  if (issueCtx) {
    const prUrl = await createIssuePR(projPath, log, issueCtx);
    return { ok: true, commitSha, prUrl: prUrl ?? undefined, message: prUrl ? `PR created: ${prUrl}` : 'pushed (PR creation failed — see log)' };
  }

  // PR pipeline mode: create a PR from the feature branch into main
  if (prPipeline) {
    const prUrl = await createPipelinePR(projPath, log);
    return { ok: true, commitSha, prUrl: prUrl ?? undefined, message: prUrl ? `PR created: ${prUrl}` : 'pushed (PR creation failed — see log)' };
  }

  return { ok: true, commitSha, message: 'pushed' };
}

function issueBranchName(issue: { number: number; title: string }): string {
  const slugTitle = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `fix/issue-${issue.number}${slugTitle ? `-${slugTitle}` : ''}`;
}

async function createIssuePR(
  projPath: string,
  log: (s: string) => void,
  issue: { number: number; repo: string; title: string },
): Promise<string | null> {
  // Determine current branch
  const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = branchR.stdout.trim();
  const mainBranch = await detectMainBranch(projPath);

  // Defensive fallback: runPush should have already moved us off main before
  // committing. If we're somehow still on main, do the old branch-off dance.
  if (!currentBranch || currentBranch === mainBranch) {
    const featureBranch = issueBranchName(issue);

    log(`\n# creating branch ${featureBranch} for issue #${issue.number}\n`);

    // Create the branch pointing at the current HEAD, then push it
    const createR = await exec('git', ['-C', projPath, 'branch', featureBranch], { timeout: 5000 });
    if (createR.stdout) log(createR.stdout);
    if (createR.stderr) log(createR.stderr);

    const pushR = await exec('git', ['-C', projPath, 'push', '-u', 'origin', featureBranch], { timeout: 30000 });
    if (pushR.stdout) log(pushR.stdout);
    if (pushR.stderr) log(pushR.stderr);
    if (pushR.exitCode !== 0) {
      log(`\n# branch push failed — skipping PR creation\n`);
      return null;
    }
  }

  // Create the PR via gh cli
  const prTitle = buildPrTitle(issue.title);
  const prBody = `Closes #${issue.number}\n\nImplemented via TamTam from issue [#${issue.number}](https://github.com/${issue.repo}/issues/${issue.number}).`;
  log(`\n# creating PR for issue #${issue.number}: "${prTitle}"\n`);

  const prArgs = [
    'pr', 'create',
    '--title', prTitle,
    '--body', prBody,
    '--base', mainBranch,
  ];
  const prR = await exec('gh', prArgs, { cwd: projPath, timeout: 30000 });
  if (prR.stdout) log(prR.stdout);
  if (prR.stderr) log(prR.stderr);

  if (prR.exitCode !== 0) {
    log(`\n# PR creation failed\n`);
    return null;
  }

  // gh pr create prints the URL on stdout
  const prUrl = prR.stdout.trim().split('\n').find(l => l.startsWith('https://')) ?? prR.stdout.trim();
  log(`\n# PR created: ${prUrl}\n`);

  // Return to main branch so the project isn't left on the feature branch
  log(`\n# checking out ${mainBranch}\n`);
  const coR = await exec('git', ['-C', projPath, 'checkout', mainBranch], { timeout: 10000 });
  if (coR.stdout) log(coR.stdout);
  if (coR.stderr) log(coR.stderr);

  return prUrl || null;
}

function prPipelineBranchName(): string {
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `tamtam/${ts}`;
}

async function createPipelinePR(projPath: string, log: (s: string) => void): Promise<string | null> {
  const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = branchR.stdout.trim();
  const mainBranch = await detectMainBranch(projPath);

  // Derive PR title from the most recent commit subject
  const logR = await exec('git', ['-C', projPath, 'log', '-1', '--pretty=%s'], { timeout: 5000 });
  const subject = logR.stdout.trim() || 'chore: tamtam update';
  const prTitle = buildPrTitle(subject);
  const prBody = `Automated PR created by TamTam from branch \`${currentBranch}\`.`;
  log(`\n# creating PR: "${prTitle}"\n`);

  const prR = await exec('gh', ['pr', 'create', '--title', prTitle, '--body', prBody, '--base', mainBranch], { cwd: projPath, timeout: 30000 });
  if (prR.stdout) log(prR.stdout);
  if (prR.stderr) log(prR.stderr);

  if (prR.exitCode !== 0) {
    log(`\n# PR creation failed\n`);
    return null;
  }

  const prUrl = prR.stdout.trim().split('\n').find(l => l.startsWith('https://')) ?? prR.stdout.trim();
  log(`\n# PR created: ${prUrl}\n`);

  // Return to main branch so the project isn't left on the feature branch
  log(`\n# checking out ${mainBranch}\n`);
  const coR = await exec('git', ['-C', projPath, 'checkout', mainBranch], { timeout: 10000 });
  if (coR.stdout) log(coR.stdout);
  if (coR.stderr) log(coR.stderr);

  return prUrl || null;
}

function buildPrTitle(issueTitle: string): string {
  const trimmed = issueTitle.trim();
  // If the issue title is already a valid conventional commit, use it as-is
  if (CONV_RE.test(trimmed)) return trimmed;
  // Strip any existing broken type prefix (e.g. "Fix: ", "Feat: ") and re-apply
  const stripped = trimmed.replace(/^[A-Za-z]+:\s*/, '');
  return `fix: ${stripped}`;
}

async function detectMainBranch(projPath: string): Promise<string> {
  const r = await exec('git', ['-C', projPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5000 });
  if (r.exitCode === 0) {
    const match = r.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1];
  }
  // Fallback: check if 'main' or 'master' exists
  const mainR = await exec('git', ['-C', projPath, 'rev-parse', '--verify', 'main'], { timeout: 3000 });
  return mainR.exitCode === 0 ? 'main' : 'master';
}
