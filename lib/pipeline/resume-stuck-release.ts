// Detect and revive releases that were finalized as "done" while their chain
// actually stopped at a non-terminal step (test / fix / review / commit) that
// exited 0. Common cause: the completion hook crashed or the server restarted
// between markDone() and the next step spawning, leaving the release marked
// success without a commit/push/merge.
//
// `findStuckFinalizedReleases` is the read-only scanner; `resumeStuckRelease`
// reopens a release and re-fires the last step's completion hook so the chain
// continues normally. The recovery ticker in `instrumentation-node.ts` calls
// both on a slow cadence so already-finalized stuck releases self-heal even
// without UI intervention.
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { listJobs, getJob, updateJob } from '@/lib/jobs/job-storage';
import { runCompletionHooks, PIPELINE_STEP_KINDS } from '@/lib/jobs/lifecycle';
import { acquireLock, releaseLock } from '@/lib/pipeline/pipeline-lock';
import {
  buildReleaseStepChain,
  getEffectiveReleaseChainTail,
  RESUMABLE_RELEASE_STEP_KINDS,
} from '@/lib/pipeline/release-chain';
import type { JobData } from '@/lib/jobs/types';

// Cap auto-resume attempts so a release that genuinely cannot continue (no
// uncommitted changes, no upstream commits, hooks decline to chain) doesn't
// get reopened on every ticker pass.
const MAX_AUTO_RESUME_ATTEMPTS = 2;
const autoResumeAttempts = new Map<string, number>();

// Only scan releases that finalized within this window. Anything older is
// considered settled and won't be touched.
const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface StuckRelease {
  release: JobData;
  lastStep: JobData;
  chainKinds: string[];
}

export async function findStuckFinalizedReleases(limit = 50): Promise<StuckRelease[]> {
  const cutoff = Date.now() / 1000 - SCAN_WINDOW_MS / 1000;
  const allReleases = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.kind, 'release'));
  const releases = allReleases
    .filter(
      (r) => r.finishedAt != null && r.exitCode === 0 && (r.finishedAt ?? 0) >= cutoff,
    )
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, limit);

  const stuck: StuckRelease[] = [];
  const all = listJobs();
  for (const release of releases) {
    const children = all.filter(
      (j) =>
        j.project === release.project &&
        j.releaseId === release.id &&
        PIPELINE_STEP_KINDS.has(j.kind),
    );
    const chain = buildReleaseStepChain(release as JobData, children);
    const last = getEffectiveReleaseChainTail(chain);
    if (!last) continue;
    if (last.exitCode !== 0) continue;
    if (!RESUMABLE_RELEASE_STEP_KINDS.has(last.kind)) continue;
    stuck.push({
      release: release as JobData,
      lastStep: last,
      chainKinds: chain.map((c) => `${c.kind}(${c.exitCode})`),
    });
  }
  return stuck;
}

export interface ResumeResult {
  ok: boolean;
  detail: string;
  status: 'resumed' | 'not_found' | 'not_stuck' | 'still_active' | 'lock_busy' | 'job_busy' | 'error';
  attempted: boolean;
  resumedFrom?: { kind: string; id: string };
  blockingJobId?: string;
}

function findBlockingRunningPipelineStep(
  projectName: string,
  releaseId: string,
): JobData | null {
  return listJobs().find(
    (job) =>
      job.project === projectName &&
      PIPELINE_STEP_KINDS.has(job.kind) &&
      job.finishedAt == null &&
      job.releaseId !== releaseId,
  ) ?? null;
}

export async function resumeStuckRelease(
  projectName: string,
  releaseId: string,
): Promise<ResumeResult> {
  const release = getJob(releaseId);
  if (!release || release.project !== projectName || release.kind !== 'release') {
    return { ok: false, status: 'not_found', detail: 'release not found', attempted: false };
  }
  if (release.finishedAt === null) {
    return { ok: false, status: 'still_active', detail: 'release is still active — nothing to resume', attempted: false };
  }

  const children = listJobs().filter(
    (j) =>
      j.project === projectName &&
      j.releaseId === releaseId &&
      PIPELINE_STEP_KINDS.has(j.kind),
  );
  const chain = buildReleaseStepChain(release, children);
  if (chain.length === 0) {
    return { ok: false, status: 'not_stuck', detail: 'release has no pipeline steps to resume from', attempted: false };
  }
  const last = getEffectiveReleaseChainTail(chain);
  if (!last) {
    return { ok: false, status: 'not_stuck', detail: 'release has no pipeline steps to resume from', attempted: false };
  }
  if (!RESUMABLE_RELEASE_STEP_KINDS.has(last.kind) || last.exitCode !== 0) {
    return {
      ok: false,
      status: 'not_stuck',
      detail: `last step ${last.kind} (exit ${last.exitCode}) is not a stuck non-terminal step — nothing to resume`,
      attempted: false,
    };
  }
  const blockingStep = findBlockingRunningPipelineStep(projectName, releaseId);
  if (blockingStep) {
    return {
      ok: false,
      status: 'job_busy',
      detail: `another pipeline step is still running for ${projectName}`,
      attempted: false,
      blockingJobId: blockingStep.id,
    };
  }

  // Re-acquire the lock first; reject if another release is already active for
  // this project (do not double-finalize or stack two "running" releases).
  try {
    const lock = await acquireLock(projectName, releaseId);
    if (!lock.acquired) {
      return {
        ok: false,
        status: 'lock_busy',
        detail: `pipeline is already running for ${projectName}`,
        attempted: false,
        blockingJobId: lock.blockingJobId,
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      detail: `failed to re-acquire pipeline lock: ${err instanceof Error ? err.message : String(err)}`,
      attempted: false,
    };
  }

  const previousFinishedAt = release.finishedAt;
  const previousExitCode = release.exitCode;
  release.finishedAt = null;
  release.exitCode = null;
  updateJob(release);

  console.log(
    `[release] resuming stuck release ${releaseId} (${projectName}) — re-firing completion hook for ${last.kind} ${last.id}`,
  );
  try {
    await runCompletionHooks(last);
  } catch (err) {
    // Roll back so the release row matches reality and the lock isn't held.
    release.finishedAt = previousFinishedAt;
    release.exitCode = previousExitCode;
    updateJob(release);
    await releaseLock(projectName, releaseId);
    return {
      ok: false,
      status: 'error',
      detail: `completion hook threw: ${err instanceof Error ? err.message : String(err)}`,
      attempted: true,
    };
  }
  return {
    ok: true,
    status: 'resumed',
    detail: 'resumed',
    attempted: true,
    resumedFrom: { kind: last.kind, id: last.id },
  };
}

// Detect agent / terminal runs that finished successfully on projects with
// auto_commit / auto_push / release_after_run enabled, but never spawned a
// release pipeline. The release-after-run completion hook is supposed to do
// this but it can be skipped on server restart, mid-hook crash, or before
// this fix added the auto_commit/auto_push fallback. Returns one entry per
// stuck terminal run for the most recent run per project (older ones are
// superseded by newer activity and shouldn't trigger their own release).
export interface OrphanedRun {
  jobId: string;
  project: string;
  finishedAt: number;
}

export function findOrphanedAgentRuns(limit = 50): OrphanedRun[] {
  const cutoff = Date.now() / 1000 - SCAN_WINDOW_MS / 1000;
  const all = listJobs();
  const candidates = all
    .filter(
      (j) =>
        j.exitCode === 0 &&
        j.finishedAt != null &&
        (j.finishedAt ?? 0) >= cutoff &&
        (j.kind === 'run' || j.kind.startsWith('agent:')),
    )
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));

  // Keep only the most recent qualifying run per project — older agent runs
  // are stale and resuming them on top of newer work would clobber it.
  const seenProjects = new Set<string>();
  const newestPerProject: JobData[] = [];
  for (const j of candidates) {
    if (seenProjects.has(j.project)) continue;
    seenProjects.add(j.project);
    newestPerProject.push(j);
  }

  const orphaned: OrphanedRun[] = [];
  for (const job of newestPerProject) {
    // Skip if a pipeline-step / release is currently running or started after
    // the agent finished — the chain is being handled (or was handled).
    // Include finishedAt === null so an in-flight release that began before the
    // agent finished is not missed by the startedAt-only guard.
    const newer = all.find(
      (j) =>
        j.project === job.project &&
        (j.kind === 'release' || PIPELINE_STEP_KINDS.has(j.kind)) &&
        (j.finishedAt === null || (j.startedAt ?? 0) > (job.finishedAt ?? 0)),
    );
    if (newer) continue;
    orphaned.push({
      jobId: job.id,
      project: job.project,
      finishedAt: job.finishedAt ?? 0,
    });
    if (orphaned.length >= limit) break;
  }
  return orphaned;
}

const orphanResumeAttempts = new Map<string, number>();

export async function autoResumeOrphanedAgentRuns(): Promise<void> {
  let orphaned: OrphanedRun[];
  try {
    orphaned = findOrphanedAgentRuns(50);
  } catch (err) {
    console.error('[auto-resume-agent] scan failed:', err);
    return;
  }
  if (orphaned.length === 0) return;
  for (const o of orphaned) {
    const attempts = orphanResumeAttempts.get(o.jobId) ?? 0;
    if (attempts >= MAX_AUTO_RESUME_ATTEMPTS) continue;
    try {
      const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
      const cfg = await getProjectTestConfig(o.project);
      const wantsAutoShip = !!(cfg?.releaseAfterRun);
      if (!wantsAutoShip) continue;
      // Only count an attempt after confirming the project wants auto-ship and
      // just before calling startRelease — mirrors autoResumeStuckReleases which
      // gates on r.attempted. This way transient config errors and lock conflicts
      // don't exhaust the retry budget without an actual release being attempted.
      orphanResumeAttempts.set(o.jobId, attempts + 1);
      const { dispatchReleaseWorkflow } = await import('@/lib/workflows/dispatch-release');
      const r = await dispatchReleaseWorkflow(o.project, { queueIfBlocked: true, sourceJobId: o.jobId });
      if (r.ok) {
        console.log(
          `[auto-resume-agent] kicked off release for ${o.project} after orphaned run ${o.jobId} (attempt ${attempts + 1}/${MAX_AUTO_RESUME_ATTEMPTS})`,
        );
      } else {
        orphanResumeAttempts.set(o.jobId, attempts);
        console.log(`[auto-resume-agent] ${o.project}: ${r.detail}`);
      }
    } catch (err) {
      orphanResumeAttempts.set(o.jobId, attempts);
      console.error(`[auto-resume-agent] ${o.jobId} threw:`, err);
    }
  }
}

// Background ticker: scan for stuck-and-finalized releases and resume them
// up to MAX_AUTO_RESUME_ATTEMPTS times each. Idempotent and best-effort —
// errors on a single release don't block others.
export async function autoResumeStuckReleases(): Promise<void> {
  let stuck: StuckRelease[];
  try {
    stuck = await findStuckFinalizedReleases(50);
  } catch (err) {
    console.error('[auto-resume] scan failed:', err);
    return;
  }
  if (stuck.length === 0) return;

  for (const s of stuck) {
    const attempts = autoResumeAttempts.get(s.release.id) ?? 0;
    if (attempts >= MAX_AUTO_RESUME_ATTEMPTS) continue;
    console.log(
      `[auto-resume] detected stuck release ${s.release.id} (${s.release.project}) — chain: ${s.chainKinds.join(' → ')} (attempt ${attempts + 1}/${MAX_AUTO_RESUME_ATTEMPTS})`,
    );
    try {
      const r = await resumeStuckRelease(s.release.project, s.release.id);
      if (r.attempted) {
        autoResumeAttempts.set(s.release.id, attempts + 1);
      }
      if (!r.ok) console.log(`[auto-resume] ${s.release.id}: ${r.detail}`);
    } catch (err) {
      console.error(`[auto-resume] ${s.release.id} threw:`, err);
    }
  }
}

export function _resetAutoResumeAttempts(): void {
  autoResumeAttempts.clear();
  orphanResumeAttempts.clear();
}
