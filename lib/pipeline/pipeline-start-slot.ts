// Atomic per-(release, phase) start claim.
//
// The release pipeline runs in-process inside the Next.js process: the Vercel
// Workflow runtime, boot recovery, and the probe sweep can all drive the same
// release. After a restart storm, MULTIPLE orchestrator runs can exist for one
// release; when a phase finishes they each dispatch the next phase within a few
// hundred ms. The dispatch-phase idempotency gate
// (`releaseHasInFlightChildOfKind`) and the per-`startProject*`
// `listJobs()` running-job checks are both check-then-create — a phase job
// doesn't exist in the cache until `createJob()` runs, several `await`s after
// the check. So N concurrent dispatches all observe "no in-flight <kind>" and
// all create a job → duplicate review/fix/commit jobs for one release.
//
// This is a synchronous claim keyed on `${releaseId}:${kind}`. Because Node is
// single-threaded, the get+set is atomic within the event loop, so it closes
// the TOCTOU window that spans the awaits up to `createJob()`. Same pattern as
// `tryClaimAgentStartSlot` (lib/agents/pending-agent-run.ts) which guards
// concurrent agent starts per project.
//
// Pinned to globalThis because Next.js duplicates modules across realms — a
// module-level Map would let each route bundle keep its own copy and the claim
// would not actually serialize. Documented in docs/PIPELINE.md + CLAUDE.md
// singletons list.

type PipelineStartSlot = {
  jobId: string | null;
  startedAt: number;
};

declare global {
  var __tamtamStartingPipelineSteps: Map<string, PipelineStartSlot> | undefined;
}

const startingSteps: Map<string, PipelineStartSlot> =
  globalThis.__tamtamStartingPipelineSteps ?? new Map<string, PipelineStartSlot>();
globalThis.__tamtamStartingPipelineSteps = startingSteps;

function keyFor(releaseId: string, kind: string): string {
  return `${releaseId}:${kind}`;
}

/**
 * Try to claim the start slot for a (release, phase-kind) pair. Returns
 * `{ ok: true }` for the first caller; concurrent callers get
 * `{ ok: false, jobId }` where `jobId` is the in-flight phase job id once it
 * exists (null if the holder hasn't created its row yet). When `releaseId` is
 * null the step isn't release-linked (standalone), so the claim is a no-op and
 * always succeeds — standalone pipeline behavior is unchanged.
 */
export function tryClaimPipelineStartSlot(
  releaseId: string | null | undefined,
  kind: string,
): { ok: true } | { ok: false; jobId: string | null } {
  if (!releaseId) return { ok: true };
  const key = keyFor(releaseId, kind);
  const existing = startingSteps.get(key);
  if (existing) return { ok: false, jobId: existing.jobId };
  startingSteps.set(key, { jobId: null, startedAt: Date.now() / 1000 });
  return { ok: true };
}

/**
 * Record the job id on a held slot so a concurrent loser can attach to the
 * actual in-flight job (vs. just knowing one is starting). No-op if the slot
 * isn't held (e.g. standalone step).
 */
export function setPipelineStartSlotJob(
  releaseId: string | null | undefined,
  kind: string,
  jobId: string,
): void {
  if (!releaseId) return;
  const key = keyFor(releaseId, kind);
  const existing = startingSteps.get(key);
  if (existing) existing.jobId = jobId;
}

/** Release a held slot. Call in a `finally` once the job row exists or the
 *  start failed. No-op when `releaseId` is null. */
export function releasePipelineStartSlot(
  releaseId: string | null | undefined,
  kind: string,
): void {
  if (!releaseId) return;
  startingSteps.delete(keyFor(releaseId, kind));
}

/** True when any phase start-slot is currently held for this release — i.e.
 *  another driver has claimed a phase start (and will create its child job).
 *  Lets a caller tell a concurrency 409 (slot held by another driver) from a
 *  permanent-refusal 409 (e.g. an execution gate), which holds no slot. */
export function hasHeldStartSlotForRelease(releaseId: string | null | undefined): boolean {
  if (!releaseId) return false;
  const prefix = `${releaseId}:`;
  for (const key of startingSteps.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/** Test/diagnostic helper — clears all held slots. */
export function _resetPipelineStartSlots(): void {
  startingSteps.clear();
}
