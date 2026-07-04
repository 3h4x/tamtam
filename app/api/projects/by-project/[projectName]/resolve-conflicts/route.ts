import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, listJobs, probeJobStatus, updateJob } from '@/lib/jobs/job-storage';
import { startJobInProcess as startJob } from '@/lib/jobs/spawn-claude-detached';
import { exec } from '@/lib/shared/shell';
import { getPermissionModeFlag, getSettings } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { checkPrBranchExecutionGate } from '@/lib/security/pr-branch-execution';
import {
  getPrForResolve,
  composeResolveConflictsPrompt,
  type ResolveConflictsMeta,
} from '@/lib/jobs/resolve-conflicts';

// Operator-initiated automated conflict resolution for an open PR branch.
// The operator's click on the inbox "Resolve conflicts" HITL is EXPLICIT
// consent (SECURITY.md: destructive git operations need an explicit request) to
// let TamTam rebase the PR branch onto its base and resolve the conflicts with
// an agent — the one thing the background sweep deliberately declines to do.
//
// This route only does the network + setup (fetch, checkout, author-trust gate)
// and spawns the agent, which resolves LOCALLY (no network needed — the base is
// pre-fetched here). finalizeResolveConflicts (run on job completion) owns the
// force-push-with-lease and the pr-wait handoff. See lib/jobs/resolve-conflicts.ts.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;

  let prNumber: number;
  try {
    const body = (await request.json()) as { prNumber?: unknown };
    prNumber = typeof body?.prNumber === 'number' ? body.prNumber : Number.NaN;
  } catch {
    return NextResponse.json({ detail: 'invalid JSON body' }, { status: 400 });
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json({ detail: 'prNumber (positive integer) is required' }, { status: 400 });
  }

  // Only one conflict-resolution per project at a time; never race a running
  // pipeline step for the same worktree.
  const jobs = listJobs();
  const runningResolve = jobs.filter(
    (j) => j.project === projectName && j.kind === 'resolve-conflicts' && j.finishedAt === null,
  );
  for (const j of runningResolve) {
    if ((await probeJobStatus(j)) === 'running') {
      return NextResponse.json(
        { detail: `Conflict resolution already in progress for ${projectName}` },
        { status: 409 },
      );
    }
  }
  const blockingJob = await findBlockingRunningJob(projectName, (job) => job.kind !== 'resolve-conflicts');
  if (blockingJob) {
    return NextResponse.json({
      detail: `Job '${blockingJob.kind}' is already running for ${projectName} (job ${blockingJob.id})`,
      blocking_job_id: blockingJob.id,
    }, { status: 409 });
  }

  const { logDir } = getImproveConfig();
  const settings = getSettings();
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  // Resolve the PR head/base/repo and confirm it is an OPEN PR that actually
  // conflicts. A MERGEABLE PR needs no resolution; a MERGED/CLOSED one must not
  // be rewritten (reused fix/issue-* branch names can point at a merged PR).
  const pr = await getPrForResolve(projPath, prNumber);
  if (!pr) {
    return NextResponse.json({ detail: `Could not resolve PR #${prNumber} for ${projectName}` }, { status: 404 });
  }
  if (pr.state !== 'OPEN') {
    return NextResponse.json({ detail: `PR #${prNumber} is ${pr.state}, not open — nothing to resolve` }, { status: 409 });
  }
  if (pr.mergeable === 'MERGEABLE') {
    return NextResponse.json({ detail: `PR #${prNumber} is already mergeable — no conflicts to resolve` }, { status: 409 });
  }

  // Fetch the base + head so the agent can rebase against a FRESH origin/<base>
  // (the trusted base) without needing network itself, and so checkout can track
  // the branch. Network runs here in the server process, not the sandboxed agent.
  const fetched = await exec('git', ['-C', projPath, 'fetch', '--quiet', 'origin', pr.base, pr.branch], { timeout: 30_000 });
  if (fetched.exitCode !== 0) {
    return NextResponse.json(
      { detail: `git fetch failed: ${(fetched.stderr || fetched.stdout || 'unknown').trim().slice(0, 200)}` },
      { status: 502 },
    );
  }

  // Refuse to touch a dirty worktree — the rebase needs a clean base and we must
  // never clobber uncommitted local work.
  const dirty = (await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 10_000 })).stdout.trim();
  if (dirty.length > 0) {
    return NextResponse.json(
      { detail: `Working tree for ${projectName} is not clean — commit/stash before resolving conflicts` },
      { status: 409 },
    );
  }

  // Check out the PR branch so both the author-trust gate and the agent operate
  // on the right commits.
  const current = (await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 10_000 })).stdout.trim();
  if (current !== pr.branch) {
    const co = await exec('git', ['-C', projPath, 'checkout', pr.branch], { timeout: 20_000 });
    if (co.exitCode !== 0) {
      const track = await exec('git', ['-C', projPath, 'checkout', '-B', pr.branch, `origin/${pr.branch}`], { timeout: 20_000 });
      if (track.exitCode !== 0) {
        return NextResponse.json(
          { detail: `could not checkout ${pr.branch}: ${(track.stderr || co.stderr || 'checkout failed').trim().slice(0, 200)}` },
          { status: 502 },
        );
      }
    }
  }

  // Author-trust boundary: never run an agent that edits code on a branch whose
  // commits aren't authored by a trusted user (SECURITY.md PR-branch gate). The
  // base is trusted unconditionally; only the branch's added commits are checked.
  const gate = checkPrBranchExecutionGate(projPath, 'resolve merge conflicts');
  if (!gate.ok) {
    return NextResponse.json({ detail: gate.detail }, { status: 409 });
  }

  const preferredProviderHeader = request.headers.get('x-tamtam-provider-preferred');
  const cliGate = await checkCliStartGate('resolve merge conflicts', {
    preferred: isCliProvider(preferredProviderHeader) ? preferredProviderHeader : null,
  });
  if (!cliGate.ok) return NextResponse.json({ detail: cliGate.detail }, { status: cliGate.status });
  const provider = cliGate.provider;
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);
  const defaultModel = resolveCliDefaultModel(provider, settings);

  // Light, best-effort context for the agent: which files the PR changes. The
  // real conflict hunks appear when the agent runs `git rebase`; this is only
  // orientation and is wrapped as untrusted content by the prompt composer.
  let changedFiles = '';
  const diff = await exec('gh', ['pr', 'diff', String(prNumber), '--repo', pr.repo, '--name-only'], { cwd: projPath, timeout: 20_000 });
  if (diff.exitCode === 0) changedFiles = diff.stdout.trim().slice(0, 2000);
  const prompt = composeResolveConflictsPrompt(pr, changedFiles ? `Files changed by this PR:\n${changedFiles}` : '');

  const meta: ResolveConflictsMeta = {
    prNumber: pr.number,
    prRepo: pr.repo,
    prUrl: pr.url,
    branch: pr.branch,
    defaultBranch: pr.base,
  };
  const job = createJob(projectName, 'resolve-conflicts', 0, '', undefined, JSON.stringify(meta));
  job.provider = provider;
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    // The agent resolves LOCALLY (rebase against the pre-fetched origin/<base> +
    // file edits) and never pushes — but under codex `auto` the workspace-write
    // seatbelt blocks writes to `.git/` internals (`.git/index.lock`,
    // `.git/rebase-merge/*`), so `git rebase --continue`/`--abort` fail with
    // "Operation not permitted" and the rebase can't complete. bypassPermissions
    // drops that sandbox so the agent can rewrite rebase state. Gated on
    // `resolve_conflicts_bypass_sandbox` (default on) as an operator kill switch;
    // finalizeResolveConflicts still owns the authoritative force-push.
    const permissionMode = getPermissionModeFlag(
      settings.resolve_conflicts_bypass_sandbox ? 'bypassPermissions' : undefined,
    );
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${defaultModel} ${permissionMode}`,
      prompt,
      projPath,
      { env: cliEnv },
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    return NextResponse.json({ detail: `Failed to start conflict resolution: ${errMsg(e)}` }, { status: 500 });
  }

  updateJob(job);

  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    log_path: logPath,
    pr_number: pr.number,
    branch: pr.branch,
  });
}
