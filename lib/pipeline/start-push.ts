import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { invalidateProject } from '@/lib/shared/gh-status';
import { exec } from '@/lib/shared/shell';
import { getImproveConfig, setProjectPushResult } from '@/lib/scheduling/scheduling';
import { currentParent } from '@/lib/jobs/parent-context';
import { createJob, markDone, updateJob } from '@/lib/jobs/job-storage';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { generateCommitMessage, findIssueContext, detectMainBranch } from './start-commit';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { createGenericPR, createIssuePR } from './pr-create';

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
  const gate = await checkCliStartGate('start a push', { parentJobId: currentParent() });
  if (!gate.ok) {
    setProjectPushResult(projectName, gate.detail);
    return gate;
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
  job.provider = gate.provider;
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

  const result = await runPush(projectName, projPath, append, earlyIssueCtx, false, gate.provider);
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
// Always push-only (no commit). The "Push to PR" flow uses startProjectCommit
// instead, which auto-chains to push via the completion hook.
export function launchProjectPush(projectName: string): { jobId: string } | { error: string; status?: number } {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { error: 'project not found' };

  // If a release pipeline is in flight, the auto-chain will push at the right
  // step. Letting the manual "Push" button race the release lets push run in
  // parallel with test/review/fix and clobbers ordering.
  const lock = getLock(projectName);
  if (lock) {
    return { error: `Pipeline is running for ${projectName} — wait for it to finish before pushing manually`, status: 409 };
  }

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
    const gate = await checkCliStartGate('start a push');
    if (!gate.ok) {
      append(`\n# push blocked (${gate.status})\n${gate.detail}\n`);
      try { setProjectPushResult(projectName, gate.detail); } catch {}
      await markDone(job, 1);
      return;
    }
    job.provider = gate.provider;
    updateJob(job);
    // Pre-check above guarantees no active pipeline; acquire the lock for this
    // standalone push so a concurrent release/agent can't sneak in mid-push.
    // The pre-check + async acquire has a TOCTOU window — if a release started
    // in between, acquireLock returns { acquired: false } (it does not throw).
    // Bail out in that case so we don't race the release on the same worktree.
    try {
      const lockResult = await acquireLock(projectName, job.id);
      if (!lockResult.acquired) {
        const detail = `Pipeline is running for ${projectName} — wait for it to finish before pushing manually`;
        append(`\n# push aborted — ${detail}\n`);
        try { setProjectPushResult(projectName, detail); } catch {}
        await markDone(job, 1);
        return;
      }
    } catch (e) {
      console.log(`[launch-push] failed to acquire pipeline lock for ${projectName}:`, e);
      append(`\n# push aborted — failed to acquire pipeline lock\n`);
      await markDone(job, 1);
      return;
    }

    const result = await runPush(projectName, projPath, append, null, true, gate.provider);
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
  provider?: string,
): Promise<PushResult> {
  // pushOnly: skip all staging/committing/PR logic — just push existing commits.
  if (pushOnly) {
    const r = await pushCurrentBranch(projPath, log);
    if (!r.ok) return { ok: false, status: 502, detail: r.detail };
    return { ok: true, commitSha: r.commitSha, message: 'pushed' };
  }

  // Resolve issue context if not passed in (e.g. called from launchProjectPush).
  if (issueCtx === undefined) issueCtx = await findIssueContext(projectName, projPath);

  // Check if there's anything to push. `rev-list @{u}..HEAD` fails with a
  // non-zero exit when @{u} is unresolvable — which happens on a fresh
  // branch that was never pushed, OR when the remote ref was deleted after
  // a squash-merge (classic zombie branch). Silently treating that as
  // "No changes to push" marooned commit ee3b5a5 on seo-tools. Distinguish:
  //   - exit 0, count > 0 → push
  //   - exit 0, count 0   → genuinely no changes
  //   - exit != 0         → no upstream; fall through to tryPush, which
  //                         retries with `--set-upstream` via the existing
  //                         fallback at lines ~245-249 when push fails with
  //                         "no upstream" / "set-upstream" stderr.
  const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
  log(`\n$ git rev-list --count @{u}..HEAD\n${aheadR.stdout}`);
  const ahead = parseInt(aheadR.stdout.trim(), 10);
  const hasUpstream = aheadR.exitCode === 0;
  if (hasUpstream && (!aheadR.stdout.trim() || isNaN(ahead) || ahead === 0)) {
    return { ok: true, commitSha: '', message: 'No changes to push' };
  }
  if (!hasUpstream) {
    // Guard against an empty HEAD (brand-new repo with no commits yet).
    const hasCommitsR = await exec('git', ['-C', projPath, 'rev-list', '--count', 'HEAD'], { timeout: 5000 });
    const hasCommits = hasCommitsR.exitCode === 0 && (parseInt(hasCommitsR.stdout.trim(), 10) || 0) > 0;
    if (!hasCommits) {
      return { ok: true, commitSha: '', message: 'No changes to push' };
    }
    log(`\n# no upstream configured — push will --set-upstream origin <branch>\n`);
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
      const fixMsg = await generateCommitMessage(projPath, projectName, provider);
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

  // PR creation rules:
  //   - Issue-linked push → ALWAYS create a PR. Clicking "Work on issue N" is
  //     an explicit opt-in to the issue-driven workflow; the user expects a
  //     PR that closes the issue regardless of the project's pr_workflow
  //     setting (which only governs *non-issue* feature branches).
  //   - Non-issue push + pr_workflow_enabled → create a generic PR for the
  //     feature branch.
  //   - Non-issue push without pr_workflow_enabled → push to current branch,
  //     no PR.
  const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
  const prWorkflowEnabled = !!getProjectTestConfig(projectName)?.prWorkflowEnabled;

  if (issueCtx) {
    const prUrl = await createIssuePR(projPath, log, issueCtx);
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
    clearProjectDataCache();
    if (prUrl) {
      const prNumber = parseInt(prUrl.split('/').pop() ?? '0', 10) || undefined;
      return { ok: true, commitSha, message: `PR created: ${prUrl}`, prUrl, prNumber, prRepo: issueCtx.repo };
    }
    return { ok: true, commitSha, message: 'pushed (PR creation failed — see log)' };
  }

  // Direct Branch mode on a fix/issue-* branch (no issue context): auto-return to
  // default branch after push so the next release targets the right branch.
  if (!prWorkflowEnabled) {
    const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
    const currentBranch = branchR?.stdout?.trim() ?? '';
    if (currentBranch.startsWith('fix/issue-')) {
      const mainBranch = await detectMainBranch(projPath);
      log(`\n# Direct Branch mode on issue branch — switching back to ${mainBranch}\n`);
      const coR = await exec('git', ['-C', projPath, 'checkout', mainBranch], { timeout: 10000 });
      if (coR.stdout) log(coR.stdout);
      if (coR.stderr) log(coR.stderr);
      clearProjectDataCache();
    }
  }

  // PR Workflow without issue context: create a generic PR for the feature branch.
  if (prWorkflowEnabled) {
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
