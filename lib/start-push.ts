import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath, clearProjectDataCache } from './project-data';
import { invalidateProject } from './gh-status';
import { exec } from './shell';
import { getImproveConfig, setProjectPushResult } from './scheduling';
import { createJob, markDone, updateJob } from './job-storage';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { generateCommitMessage, findIssueContext, detectMainBranch } from './start-commit';

export type PushResult =
  | { ok: true; commitSha: string; message: string; prUrl?: string; prNumber?: number; prRepo?: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string };

export async function startProjectPush(projectName: string): Promise<PushResult> {
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
  // Stamp issue context on the push job so downstream hooks can pick it up
  // without re-scanning run jobs (avoids context loss on intervening runs).
  const earlyIssueCtx = await findIssueContext(projectName, projPath);
  const job = createJob(
    projectName, 'push', process.pid, '',
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
      console.log(`[start-push] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  const append = (s: string) => {
    try { appendFileSync(logPath, s); } catch {}
  };
  append(`# push start — ${new Date().toISOString()}\n# repo: ${projPath}\n`);

  const result = await runPush(projectName, projPath, append, earlyIssueCtx);
  try {
    setProjectPushResult(projectName, result.ok ? null : result.detail);
  } catch {}
  if (result.ok) {
    invalidateProject(projectName);
    clearProjectDataCache();
    append(`\n# push ok — ${'commitSha' in result && result.commitSha ? result.commitSha : 'no-op'}\n${result.message}\n`);
    // Stamp PR metadata on the job so the completion hook can start pr-wait.
    if (result.prUrl) {
      job.contextMeta = JSON.stringify({ prUrl: result.prUrl, prNumber: result.prNumber, prRepo: result.prRepo });
      updateJob(job);
    }
  } else {
    append(`\n# push failed (${result.status})\n${result.detail}\n`);
  }

  await markDone(job, result.ok ? 0 : 1);
  return result;
}

// Fire-and-forget variant: creates the job synchronously, runs push in the
// background, and returns the job ID immediately so callers can stream output.
// Fire-and-forget push used by the UI Push button — always push-only (no commit, no PR).
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

    const result = await runPush(projectName, projPath, append, null, true);
    try { setProjectPushResult(projectName, result.ok ? null : result.detail); } catch {}
    if (result.ok) {
      invalidateProject(projectName);
      clearProjectDataCache();
      append(`\n# push ok — ${'commitSha' in result && result.commitSha ? result.commitSha : 'no-op'}\n${result.message}\n`);
      if (result.prUrl) {
        job.contextMeta = JSON.stringify({ prUrl: result.prUrl, prNumber: result.prNumber, prRepo: result.prRepo });
        updateJob(job);
      }
    } else {
      append(`\n# push failed (${result.status})\n${result.detail}\n`);
    }
    await markDone(job, result.ok ? 0 : 1);
  })();

  return { jobId: job.id };
}

// Push-only: just push existing commits, with the same set-upstream fallback
// used by the release pipeline. Shared by runPush(pushOnly) and the
// Create-PR endpoint so both get the same resilience semantics.
export async function pushCurrentBranch(
  projPath: string,
  log: (s: string) => void = () => {},
): Promise<{ ok: true; commitSha: string } | { ok: false; detail: string }> {
  const PUSH_TIMEOUT = 25 * 60 * 1000;
  const tryPush = async (extraArgs: string[] = []) => {
    const args = ['-C', projPath, 'push', ...extraArgs];
    log(`\n$ git push${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}\n`);
    const r = await exec('git', args, { timeout: PUSH_TIMEOUT, killProcessGroup: true });
    if (r.stdout) log(r.stdout);
    if (r.stderr) log(r.stderr);
    return r;
  };
  let pushR = await tryPush();
  if (pushR.exitCode !== 0 && (pushR.stderr.includes('no upstream') || pushR.stderr.includes('set-upstream'))) {
    const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
    const branch = branchR.stdout.trim();
    if (branch) pushR = await tryPush(['-u', 'origin', branch]);
  }
  if (pushR.exitCode !== 0) {
    const detail = (pushR.stderr.trim() || pushR.stdout.trim() || `git push exited ${pushR.exitCode}`).slice(0, 2000);
    return { ok: false, detail: `Push failed: ${detail}` };
  }
  const shaR = await exec('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
  return { ok: true, commitSha: shaR.exitCode === 0 ? shaR.stdout.trim() : '' };
}

async function runPush(
  projectName: string,
  projPath: string,
  log: (s: string) => void,
  issueCtx?: { number: number; repo: string; title: string } | null,
  pushOnly?: boolean,
): Promise<PushResult> {
  // pushOnly: skip all staging/committing/PR logic — just push existing commits.
  if (pushOnly) {
    const r = await pushCurrentBranch(projPath, log);
    if (!r.ok) return { ok: false, status: 502, detail: r.detail };
    return { ok: true, commitSha: r.commitSha, message: 'pushed' };
  }

  // Resolve issue context if not passed in (e.g. called from launchProjectPush).
  if (issueCtx === undefined) issueCtx = await findIssueContext(projectName, projPath);

  // Check if there's anything to push (any commits ahead of remote).
  const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
  log(`\n$ git rev-list --count @{u}..HEAD\n${aheadR.stdout}`);
  const ahead = parseInt(aheadR.stdout.trim(), 10);
  if (!aheadR.stdout.trim() || aheadR.exitCode !== 0 || isNaN(ahead) || ahead === 0) {
    return { ok: true, commitSha: '', message: 'No changes to push' };
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

  // If this session was started from a GitHub issue, create a PR that closes it.
  // Otherwise in PR Workflow mode, create a generic PR for the feature branch.
  // In both cases, return to the default branch so the working copy is clean.
  // Failures here are non-fatal — the push already succeeded.
  if (issueCtx) {
    const prUrl = await createIssuePR(projPath, log, issueCtx);
    if (prUrl) {
      const prNumber = parseInt(prUrl.split('/').pop() ?? '0', 10) || undefined;
      const mainBranch = await detectMainBranch(projPath);
      log(`\n# switching back to ${mainBranch} and pulling\n`);
      const coR = await exec('git', ['-C', projPath, 'checkout', mainBranch], { timeout: 10000 });
      if (coR.stdout) log(coR.stdout);
      if (coR.stderr) log(coR.stderr);
      if (coR.exitCode === 0) {
        const pullR = await exec('git', ['-C', projPath, 'pull', '--ff-only', 'origin', mainBranch], { timeout: 30000 });
        if (pullR.stdout) log(pullR.stdout);
        if (pullR.stderr) log(pullR.stderr);
      }
      return { ok: true, commitSha, message: `PR created: ${prUrl}`, prUrl, prNumber, prRepo: issueCtx.repo };
    }
    return { ok: true, commitSha, message: 'pushed (PR creation failed — see log)' };
  }

  // Non-issue PR Workflow: create a PR if pr_workflow_enabled.
  const { getProjectTestConfig } = await import('./scheduling');
  if (getProjectTestConfig(projectName)?.prWorkflowEnabled) {
    const prResult = await createGenericPR(projPath, log);
    if (prResult) {
      const prNumber = parseInt(prResult.prUrl.split('/').pop() ?? '0', 10) || undefined;
      const mainBranch = await detectMainBranch(projPath);
      log(`\n# switching back to ${mainBranch} and pulling\n`);
      const coR = await exec('git', ['-C', projPath, 'checkout', mainBranch], { timeout: 10000 });
      if (coR.stdout) log(coR.stdout);
      if (coR.stderr) log(coR.stderr);
      if (coR.exitCode === 0) {
        const pullR = await exec('git', ['-C', projPath, 'pull', '--ff-only', 'origin', mainBranch], { timeout: 30000 });
        if (pullR.stdout) log(pullR.stdout);
        if (pullR.stderr) log(pullR.stderr);
      }
      return { ok: true, commitSha, message: `PR created: ${prResult.prUrl}`, prUrl: prResult.prUrl, prNumber, prRepo: prResult.prRepo };
    }
    if (prResult === false) {
      return { ok: true, commitSha, message: 'pushed' };
    }
    return { ok: true, commitSha, message: 'pushed (PR creation failed — see log)' };
  }

  return { ok: true, commitSha, message: 'pushed' };
}

// Returns the PR info on success, false when intentionally skipped (already on
// default branch), or null when gh pr create actually failed.
async function createGenericPR(
  projPath: string,
  log: (s: string) => void,
): Promise<{ prUrl: string; prRepo: string } | false | null> {
  const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = branchR.stdout.trim();
  const mainBranch = await detectMainBranch(projPath);

  if (!currentBranch || currentBranch === mainBranch) {
    log(`\n# PR Workflow: on default branch — skipping PR creation\n`);
    return false;
  }

  // Check if a PR already exists for this branch to avoid duplicates.
  const existingR = await exec('gh', ['pr', 'view', '--json', 'url'], { cwd: projPath, timeout: 10000 });
  if (existingR.exitCode === 0 && existingR.stdout.trim()) {
    try {
      const existing = JSON.parse(existingR.stdout.trim()) as { url?: string };
      if (existing.url) {
        log(`\n# PR already exists: ${existing.url}\n`);
        const repoR = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: projPath, timeout: 10000 });
        return { prUrl: existing.url, prRepo: repoR.stdout.trim() };
      }
    } catch {}
  }

  log(`\n# PR Workflow — creating PR for branch ${currentBranch}\n`);
  const prR = await exec('gh', ['pr', 'create', '--fill', '--base', mainBranch], { cwd: projPath, timeout: 30000 });
  if (prR.stdout) log(prR.stdout);
  if (prR.stderr) log(prR.stderr);
  if (prR.exitCode !== 0) {
    log(`\n# PR creation failed\n`);
    return null;
  }

  const prUrl = prR.stdout.trim().split('\n').find(l => l.startsWith('https://')) ?? prR.stdout.trim();
  if (!prUrl) return null;

  const repoR = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: projPath, timeout: 10000 });
  log(`\n# PR created: ${prUrl}\n`);
  return { prUrl, prRepo: repoR.stdout.trim() };
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

  // Defensive fallback: runCommit should have already moved us off main before
  // committing. If we're somehow still on main, do the old branch-off dance.
  if (!currentBranch || currentBranch === mainBranch) {
    const { issueBranchName } = await import('./start-commit');
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
  // Conventional-commit prefix — lowercase. If the issue title already starts
  // with a conventional-commit type (feat:/fix:/…), pass it through as-is to
  // avoid double-prefixing.
  const prTitle = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\(.+?\))?:\s/i.test(issue.title)
    ? issue.title
    : `fix: ${issue.title}`;
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
  return prUrl || null;
}
