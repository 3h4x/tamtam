import { mkdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { exec } from '@/lib/shared/shell';
import { createJob, getJob, markDone, updateJob } from '@/lib/jobs/job-storage';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { isJobsPaused } from '@/lib/shared/job-control';
import { riskyPrDiffFiles } from '@/lib/security/pr-branch-execution';
import type { JobData } from '@/lib/jobs/types';

export type PrWaitResult =
  | { ok: true; jobId: string; merged: boolean; message: string }
  | { ok: false; status: number; detail: string; jobId?: string };

// Stamp the terminal reason onto the inline pr-wait job's contextMeta, then
// mark it done. The inline loop historically called markDone(job, 1) on a
// CONFLICTING PR WITHOUT recording why, so inbox.ts (which reads
// contextMeta.prWaitReason to choose the HITL action) fell back to a generic
// 'Merge' button — a doomed one-click on a conflicting PR. Recording 'conflict'
// here (mirroring the workflow path's finalizePrWaitStep) makes the inbox emit
// the 'Resolve conflicts' action instead. Best-effort: an unparseable
// contextMeta just leaves the generic fallback in place. 'conflict' is NOT in
// NO_HITL_REASONS, so it still surfaces as a HITL (merge-or-HITL invariant).
async function finalizeInlinePrWait(job: JobData, reason: string): Promise<void> {
  try {
    const meta = job.contextMeta ? (JSON.parse(job.contextMeta) as Record<string, unknown>) : {};
    meta.prWaitReason = reason;
    job.contextMeta = JSON.stringify(meta);
    updateJob(job);
  } catch {
    // Leave contextMeta as-is; inbox falls back to the generic manual-merge copy.
  }
  await markDone(job, 1);
}

const POLL_INTERVAL_MS = parseInt(process.env.TAMTAM_PR_WAIT_POLL_MS ?? '', 10) || 30_000;
const TIMEOUT_MS = parseInt(process.env.TAMTAM_PR_WAIT_TIMEOUT_MS ?? '', 10) || 30 * 60 * 1000; // 30 minutes
// Grace period before treating an empty statusCheckRollup as "no CI configured".
// On a freshly opened PR, GitHub has not yet registered workflow runs, so the
// rollup is briefly empty even when CI is about to fire.
const NO_CHECKS_GRACE_MS = (() => {
  const raw = parseInt(process.env.TAMTAM_PR_WAIT_NO_CHECKS_GRACE_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 90_000;
})();
// Minimum consecutive polls observing an empty statusCheckRollup before we
// treat the PR as "no CI configured" and merge. This is an extra guard on top
// of the time-based grace window above.
const NO_CHECKS_MIN_POLLS = (() => {
  const raw = parseInt(process.env.TAMTAM_PR_WAIT_NO_CHECKS_MIN_POLLS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
})();

// statusCheckRollup mixes two GraphQL types:
//   * `CheckRun` (GitHub Actions, etc.) — has `status` (QUEUED|IN_PROGRESS|COMPLETED)
//     and `conclusion` (SUCCESS|FAILURE|NEUTRAL|SKIPPED|...).
//   * `StatusContext` (legacy commit statuses — Vercel, CircleCI, …) — has
//     `state` (PENDING|SUCCESS|ERROR|FAILURE) and no `status`/`conclusion`.
// Treating the second shape as the first leaves StatusContexts permanently
// "pending" because `c.status` is `undefined !== 'COMPLETED'`, so a PR that is
// already MERGEABLE with a passing legacy status check polls forever.
interface PrStatus {
  state: string; // OPEN | MERGED | CLOSED
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
  checks: Array<{
    __typename?: string;
    name?: string;
    context?: string;
    // CheckRun fields
    status?: string;
    conclusion?: string | null;
    // StatusContext fields
    state?: string;
  }>;
}

export async function getPrStatus(projPath: string, prNumber: number, repo: string): Promise<PrStatus | null> {
  const r = await exec(
    'gh',
    ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,mergeable,statusCheckRollup'],
    { cwd: projPath, timeout: 15000 },
  );
  if (r.exitCode !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    return {
      state: (data.state ?? '').toUpperCase(),
      mergeable: (data.mergeable ?? 'UNKNOWN').toUpperCase(),
      checks: Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [],
    };
  } catch {
    return null;
  }
}

function classifyCheck(c: PrStatus['checks'][number]): 'pass' | 'fail' | 'pending' {
  // StatusContext (legacy commit statuses, e.g. Vercel): only has `state`.
  if (c.__typename === 'StatusContext' || (c.state !== undefined && c.status === undefined)) {
    const s = (c.state ?? '').toUpperCase();
    if (s === 'PENDING' || s === 'EXPECTED' || s === '') return 'pending';
    if (s === 'SUCCESS') return 'pass';
    return 'fail'; // ERROR | FAILURE | anything unknown
  }
  // CheckRun (GitHub Actions, etc.): has `status` + `conclusion`.
  if ((c.status ?? '').toUpperCase() !== 'COMPLETED') return 'pending';
  const conc = (c.conclusion ?? '').toUpperCase();
  if (conc === 'SUCCESS' || conc === 'NEUTRAL' || conc === 'SKIPPED') return 'pass';
  return 'fail';
}

export function checksConclusion(checks: PrStatus['checks']): 'pass' | 'fail' | 'pending' | 'none' {
  if (checks.length === 0) return 'none';
  const classified = checks.map(classifyCheck);
  if (classified.includes('fail')) return 'fail';
  if (classified.includes('pending')) return 'pending';
  return 'pass';
}

type MergeOutcome = { ok: true } | { ok: false; permanent: boolean };

export async function doMerge(projPath: string, prNumber: number, repo: string, log: (s: string) => void): Promise<MergeOutcome> {
  const riskyFiles = riskyPrDiffFiles(projPath, prNumber, repo);
  if (riskyFiles.length > 0) {
    log(`\n# refusing auto-merge: PR diff touches high-risk execution files\n${riskyFiles.map((f) => `- ${f}`).join('\n')}\n`);
    return { ok: false, permanent: true };
  }
  log(`\n# merging PR #${prNumber} with squash\n`);
  const args = ['pr', 'merge', String(prNumber), '--repo', repo, '--squash', '--delete-branch'];
  const r = await exec('gh', args, { cwd: projPath, timeout: 60000 });
  if (r.stdout) log(r.stdout);
  if (r.stderr) log(r.stderr);
  if (r.exitCode !== 0) {
    // Fall back to --auto if direct merge is blocked by pending checks (not a permanent error).
    if (/required status checks|mergeable|pending/i.test(r.stderr) && !/not allowed/i.test(r.stderr)) {
      log(`\n# direct merge blocked — enabling auto-merge\n`);
      const autoArgs = ['pr', 'merge', String(prNumber), '--repo', repo, '--squash', '--auto'];
      const autoR = await exec('gh', autoArgs, { cwd: projPath, timeout: 30000 });
      if (autoR.stdout) log(autoR.stdout);
      if (autoR.stderr) log(autoR.stderr);
      // --auto accepted: GitHub will merge once checks pass — treat as success.
      if (autoR.exitCode === 0) return { ok: true };
      // --auto also failed: transient — allow retry on next poll cycle.
      return { ok: false, permanent: false };
    }
    // Any other merge failure is a permanent error — stop retrying.
    return { ok: false, permanent: true };
  }
  return { ok: true };
}

export async function switchToDefault(projPath: string, log: (s: string) => void): Promise<{ ok: boolean; branch: string }> {
  try {
    const [symR, curR] = await Promise.all([
      exec('git', ['-C', projPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5000 }),
      exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 }),
    ]);
    let mainBranch = 'main';
    if (symR.exitCode === 0) {
      const m = symR.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
      if (m) mainBranch = m[1];
    }
    const featureBranch = curR.stdout.trim();
    if (featureBranch === mainBranch) {
      const pullR = await exec('git', ['-C', projPath, 'pull', '--ff-only', 'origin', mainBranch], { timeout: 30000 });
      if (pullR.stdout) log(pullR.stdout);
      if (pullR.stderr) log(pullR.stderr);
      return { ok: true, branch: mainBranch };
    }

    const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
    const dirty = statusR.stdout.trim().length > 0;
    let stashed = false;
    if (dirty) {
      const stashR = await exec('git', ['-C', projPath, 'stash', 'push', '-u', '-m', `tamtam: pre-merge-switch ${Date.now()}`], { timeout: 10000 });
      stashed = stashR.exitCode === 0 && !/No local changes/i.test(stashR.stdout);
    }

    const coR = await exec('git', ['-C', projPath, 'checkout', mainBranch], { timeout: 10000 });
    if (coR.stdout) log(coR.stdout);
    if (coR.stderr) log(coR.stderr);
    if (coR.exitCode !== 0) {
      if (stashed) await exec('git', ['-C', projPath, 'stash', 'pop'], { timeout: 10000 });
      return { ok: false, branch: mainBranch };
    }

    const pullR = await exec('git', ['-C', projPath, 'pull', '--ff-only', 'origin', mainBranch], { timeout: 30000 });
    if (pullR.stdout) log(pullR.stdout);
    if (pullR.stderr) log(pullR.stderr);
    if (stashed) await exec('git', ['-C', projPath, 'stash', 'pop'], { timeout: 10000 });

    // Delete the local feature branch. `gh pr merge --delete-branch` handles
    // the remote ref, but the local ref lingers — and if it stays around,
    // a subsequent issue-branch call for the same issue will silently re-check
    // it out, piling new commits on top of an already-merged branch. Use -D
    // because squash-merges leave the local branch looking "not merged" from
    // git's view even though GitHub confirmed the merge.
    if (featureBranch && featureBranch !== mainBranch) {
      const delR = await exec('git', ['-C', projPath, 'branch', '-D', featureBranch], { timeout: 5000 });
      if (delR.exitCode === 0) {
        log(`\n# deleted local branch ${featureBranch}\n`);
      } else if (delR.stderr) {
        log(`\n# warning: could not delete local branch ${featureBranch}: ${delR.stderr.trim()}\n`);
      }
    }

    return { ok: true, branch: mainBranch };
  } catch (e) {
    log(`\n# post-merge checkout error: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: false, branch: 'unknown' };
  }
}

export interface PrWaitContextMeta {
  prNumber: number;
  prRepo: string;
  prUrl: string;
}

/**
 * Resolve the `{ prRepo, prUrl }` a pr-wait needs from just a PR number, via
 * `gh pr view`. Shared by the manual `/pr-wait` route and the PR-review
 * auto-merge handoff so both derive the head repo/URL the same way.
 */
export async function resolvePrTarget(
  projPath: string,
  prNumber: number,
): Promise<{ prRepo: string; prUrl: string } | { error: string }> {
  const ghOut = await exec(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'url,headRepositoryOwner,headRepository'],
    { cwd: projPath, timeout: 15000 },
  );
  if (ghOut.exitCode !== 0) {
    return { error: `gh pr view failed: ${ghOut.stderr || ghOut.stdout}` };
  }
  try {
    const parsed = JSON.parse(ghOut.stdout) as {
      url?: string;
      headRepositoryOwner?: { login?: string };
      headRepository?: { name?: string };
    };
    const prUrl = parsed.url;
    const prRepo = parsed.headRepositoryOwner?.login && parsed.headRepository?.name
      ? `${parsed.headRepositoryOwner.login}/${parsed.headRepository.name}`
      : undefined;
    if (!prRepo || !prUrl) return { error: 'could not resolve prRepo/prUrl' };
    return { prRepo, prUrl };
  } catch (err) {
    return { error: `gh pr view parse: ${(err as Error).message}` };
  }
}

function canonicalizeInlinePrWaitJob(job: JobData): void {
  // Resumed pr-wait jobs must use the inline sentinel pid=0 so
  // probeJobStatus keeps treating them as self-finalizing in-process work.
  if (job.pid !== 0) {
    job.pid = 0;
    updateJob(job);
  }
}

function runPrWaitLoop(
  job: JobData,
  projPath: string,
  prNumber: number,
  prRepo: string,
  _prUrl: string,
): void {
  const logPath = job.logPath ?? '';
  const log = (s: string) => { try { appendRedactedFileSync(logPath, s); } catch {} };

  ;(async () => {
    try {
      const startedAt = Date.now();
      const deadline = startedAt + TIMEOUT_MS;
      let merged = false;
      let consecutiveNoChecks = 0;

      while (Date.now() < deadline) {
        const status = await getPrStatus(projPath, prNumber, prRepo);
        if (!status) {
          log(`\n# could not fetch PR status — retrying in ${POLL_INTERVAL_MS / 1000}s\n`);
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        log(`\n# PR state: ${status.state} | mergeable: ${status.mergeable} | checks: ${checksConclusion(status.checks)}\n`);

        if (status.state === 'MERGED') {
          log(`\n# PR already merged\n`);
          merged = true;
          break;
        }

        if (status.state === 'CLOSED') {
          log(`\n# PR was closed without merging\n`);
          await markDone(job, 1);
          return;
        }

        const conclusion = checksConclusion(status.checks);

        if (conclusion === 'fail') {
          const failedChecks = status.checks
            .filter(c => classifyCheck(c) === 'fail')
            .map(c => `  ${c.name ?? c.context ?? '?'}: ${(c.conclusion ?? c.state ?? 'unknown').toLowerCase()}`)
            .join('\n');
          log(`\n# checks failed:\n${failedChecks}\n`);
          // Stamp a distinct terminal reason so the inbox surfaces a CI-specific
          // HITL ("CI failing — fix first") instead of the generic manual-merge
          // copy. This inline loop does NOT self-heal via fix-ci (that is the
          // release-linked workflow path's job), so a red PR here is a real
          // human decision — it must surface, not silently stop. 'ci_failed' is
          // deliberately NOT in inbox's NO_HITL_REASONS.
          await finalizeInlinePrWait(job, 'ci_failed');
          return;
        }

        if (conclusion === 'pass' || conclusion === 'none') {
          if (status.mergeable === 'CONFLICTING') {
            log(`\n# PR has merge conflicts — cannot auto-merge\n`);
            await finalizeInlinePrWait(job, 'conflict');
            return;
          }

          // Wait for GitHub to compute mergeability before merging — UNKNOWN
          // on a freshly opened PR can flip to CONFLICTING on the next poll.
          if (status.mergeable !== 'MERGEABLE') {
            log(`\n# mergeable=${status.mergeable} — waiting for GitHub to compute\n`);
            consecutiveNoChecks = 0;
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            continue;
          }

          // No checks reported yet — require N consecutive empty rollups
          // before treating the PR as "no CI configured". Otherwise we merge
          // on the first poll of a brand-new PR, racing a workflow that is
          // about to start.
          if (conclusion === 'none') {
            consecutiveNoChecks += 1;
            const noChecksElapsedMs = Date.now() - startedAt;
            if (consecutiveNoChecks < NO_CHECKS_MIN_POLLS || noChecksElapsedMs < NO_CHECKS_GRACE_MS) {
              const remainingGraceMs = Math.max(0, NO_CHECKS_GRACE_MS - noChecksElapsedMs);
              log(
                `\n# no checks reported (${consecutiveNoChecks}/${NO_CHECKS_MIN_POLLS}) — ` +
                `waiting ${Math.ceil(remainingGraceMs / 1000)}s more for CI to register\n`,
              );
              await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
              continue;
            }
          } else {
            consecutiveNoChecks = 0;
          }

          const mergeResult = await doMerge(projPath, prNumber, prRepo, log);
          if (mergeResult.ok) {
            log(`\n# merge succeeded\n`);
            merged = true;
            break;
          } else if (mergeResult.permanent) {
            log(`\n# merge failed permanently — stopping\n`);
            await markDone(job, 1);
            return;
          } else {
            log(`\n# merge failed transiently — will retry\n`);
          }
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!merged) {
        log(`\n# pr-wait timed out after ${TIMEOUT_MS / 60000} minutes\n`);
        await markDone(job, 1);
        return;
      }

      // Post-merge: switch back to default branch
      log(`\n# switching back to default branch after merge\n`);
      const switchResult = await switchToDefault(projPath, log);
      if (!switchResult.ok) {
        log(`\n# ERROR: failed to switch to default branch after merge — working tree may be on feature branch\n`);
        // Still mark done with failure so the UI surfaces it
        await markDone(job, 1);
        return;
      }
      log(`\n# on ${switchResult.branch}\n`);

      // Run mark-dod post-merge so verification reflects the merged state.
      // Prefer the linked issue when one exists: acceptance-criteria
      // checklists usually live in the issue body, not the PR body. Walk
      // the parent chain to find an ancestor stamped with gh_issue_number
      // (typically the push or commit job). Without this, mark-dod reads
      // the PR body — which carries only "Closes #N" and no checklist —
      // and reports "no unchecked DoD boxes — nothing to verify".
      let issueTarget: { issueNumber: number; repo: string } | null = null;
      const seen = new Set<string>();
      let cursor: string | null = job.parentJobId ?? null;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const ancestor: JobData | null = getJob(cursor) ?? null;
        if (!ancestor) break;
        if (ancestor.ghIssueNumber != null && ancestor.ghIssueRepo) {
          issueTarget = { issueNumber: ancestor.ghIssueNumber, repo: ancestor.ghIssueRepo };
          break;
        }
        cursor = ancestor.parentJobId ?? null;
      }
      try {
        const { startMarkDod } = await import('./start-mark-dod');
        const target = issueTarget
          ? { ...issueTarget }
          : { prNumber, repo: prRepo };
        log(`\n# mark-dod target: ${issueTarget ? `issue #${issueTarget.issueNumber}` : `PR #${prNumber}`}\n`);
        const md = await startMarkDod(job.project, target);
        if (md.ok) {
          log(`\n# mark-dod: ${md.verified}/${md.total} verified${md.changed ? ' (issue updated)' : ''}\n`);
        }
      } catch (e) {
        log(`\n# mark-dod error: ${e instanceof Error ? e.message : String(e)}\n`);
      }

      log(`\n# pr-wait done — PR #${prNumber} merged\n`);
      await markDone(job, 0);
      // A release-linked pr-wait that ran INLINE — i.e. RESUMED after a restart
      // — must hand back to the orchestrator so the post-merge soak phase runs
      // (post-merge CI watch / auto-fix-ci). The orchestrator awaits the pr-wait
      // job's completion, but that await does not survive a restart, so without
      // this an interrupted-and-resumed pr-wait ends the release here and
      // silently skips soak. Standalone pr-waits (no releaseId) are unaffected.
      if (job.releaseId) {
        try {
          const { safeStartOrchestrator } = await import('@/lib/workflows/safe-start-orchestrator');
          await safeStartOrchestrator(job.id, job.project, job.releaseId, 'pr-wait-inline-merge');
        } catch (e) {
          log(`\n# post-merge orchestrator dispatch failed: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    } catch (e) {
      log(`\n# pr-wait error: ${e instanceof Error ? e.message : String(e)}\n`);
      await markDone(job, 1);
    }
  })();
}

/**
 * Poll PR checks and auto-merge once they pass. Runs as a background async
 * job — fire-and-forget. Returns immediately with the jobId.
 *
 * On merge: switches working copy back to the default branch and runs mark-dod.
 * On check failure or timeout: marks job failed so the UI surfaces the problem.
 *
 * The job's contextMeta stores `{ prNumber, prRepo, prUrl }` so a server
 * restart can resume the wait via `resumePrWait` instead of abandoning it.
 */
export function launchPrWait(
  projectName: string,
  prNumber: number,
  prRepo: string,
  prUrl: string,
  options: { allowWhilePaused?: boolean } = {},
): { jobId: string } | { error: string } {
  // Honor the global pause gate. Sweep-triggered + manual pr-wait routes
  // would otherwise start new background work while operators have
  // explicitly paused everything. In-release continuation (the release
  // orchestrator dispatching pr-wait after mark-dod) sets
  // `allowWhilePaused: true` so the in-flight release doesn't stall on a
  // pause flipped mid-pipeline — it still has to ship.
  if (!options.allowWhilePaused && isJobsPaused()) {
    return { error: 'jobs paused' };
  }
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { error: 'project not found' };

  const { logDir } = getImproveConfig();
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  const meta: PrWaitContextMeta = { prNumber, prRepo, prUrl };
  const job = createJob(projectName, 'pr-wait', 0, '', undefined, JSON.stringify(meta));
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);

  try { appendRedactedFileSync(logPath, `# pr-wait start — ${new Date().toISOString()}\n# PR #${prNumber} ${prUrl}\n`); } catch {}

  runPrWaitLoop(job, projPath, prNumber, prRepo, prUrl);
  return { jobId: job.id };
}

/**
 * Resume an in-flight pr-wait job after a server restart. Re-attaches the
 * polling loop to the existing job row using the prNumber/prRepo/prUrl saved
 * in its contextMeta. The original log file is appended to so the UI keeps
 * a continuous trace.
 */
export function resumePrWait(jobId: string): { ok: true } | { ok: false; error: string } {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.kind !== 'pr-wait') return { ok: false, error: 'not a pr-wait job' };
  if (job.finishedAt !== null) return { ok: false, error: 'job already finished' };
  if (!job.contextMeta) return { ok: false, error: 'missing contextMeta — cannot resume' };

  let meta: PrWaitContextMeta;
  try {
    const parsed = JSON.parse(job.contextMeta);
    if (typeof parsed?.prNumber !== 'number' || typeof parsed?.prRepo !== 'string' || typeof parsed?.prUrl !== 'string') {
      return { ok: false, error: 'malformed contextMeta' };
    }
    meta = parsed as PrWaitContextMeta;
  } catch (e) {
    return { ok: false, error: `contextMeta parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const projPath = resolveProjectPath(job.project);
  if (!projPath) return { ok: false, error: 'project not found' };

  canonicalizeInlinePrWaitJob(job);

  if (!job.logPath) {
    const { logDir } = getImproveConfig();
    mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });
    job.logPath = join(logDir, `${job.id}.log`);
    updateJob(job);
  }

  try { appendRedactedFileSync(job.logPath, `\n# pr-wait resumed after server restart — ${new Date().toISOString()}\n`); } catch {}

  runPrWaitLoop(job, projPath, meta.prNumber, meta.prRepo, meta.prUrl);
  return { ok: true };
}
