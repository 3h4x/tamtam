import { listJobs, updateJob } from '@/lib/jobs/job-storage';

/**
 * Resolve any outstanding pr-wait HITL for a PR that was just merged through
 * TamTam (the inbox "Merge" button, the Issues-tab merge, or an agent's
 * `merge-pr` action).
 *
 * A pr-wait that deferred auto-merge to a human finishes non-zero with a defer
 * reason (e.g. `risky_diff`, `conflict`, `merge_permanent`), which the inbox
 * surfaces as a `pr_needs_manual_merge` signal. Merging the PR IS that HITL's
 * resolution, so stamp the job with the `merged` terminal reason: the inbox
 * derivation then suppresses the signal via its existing NO_HITL path,
 * independent of the gh-issues cache (which the operator merge paths
 * delete/refresh).
 *
 * Without this, the pr-wait terminal reason stays at its defer reason and the
 * derivation — which deliberately fails open when it cannot confirm the PR is
 * closed — keeps the card alive, so the merge that RESOLVES the HITL becomes
 * the one action that can never clear it. Mirrors the `merged` finalize the
 * pipeline's own pr-wait already performs (finalizePrWaitStep).
 *
 * PRECONDITION: only call this after the PR has ACTUALLY merged — never after a
 * `gh pr merge --auto` that merely enabled auto-merge with checks still pending
 * (the PR may never land). Callers gate on that (see the merge routes).
 */
export function resolvePrWaitHitlForMergedPr(project: string, prNumber: number): void {
  for (const job of listJobs()) {
    if (job.project !== project || job.kind !== 'pr-wait' || !job.contextMeta) continue;
    // Only a finished, non-zero pr-wait raises a manual-merge HITL. A clean
    // (exit 0) or still-running pr-wait is not a stranded signal to clear.
    if (job.finishedAt === null || (job.exitCode ?? 0) === 0) continue;
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(job.contextMeta);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      meta = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (meta.prNumber !== prNumber || meta.prWaitReason === 'merged') continue;
    meta.prWaitReason = 'merged';
    job.contextMeta = JSON.stringify(meta);
    updateJob(job);
  }
}
