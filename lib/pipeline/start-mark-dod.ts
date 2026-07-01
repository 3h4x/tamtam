// Legacy entry point: a synchronous composition of the mark-dod helpers in
// lib/workflows/phases/mark-dod-impl.ts. The phase workflow drives the same
// helpers as separate `'use step'` bodies. This wrapper exists so:
//
//   - pr-wait's post-merge call (lib/pipeline/start-pr-wait.ts) keeps working
//     without becoming workflow-aware.
//   - the IssuesTab "DoD" badge route can still invoke mark-dod inline with a
//     known override.
//
// New callers should prefer dispatching `releaseMarkDodPhaseWorkflow` so the
// workflow runtime owns the lifecycle.

export { extractCriteria, tickCriteria } from './mark-dod-criteria';

import {
  prepareMarkDod,
  fetchAndExtractMarkDodCriteria,
  switchBranchForMarkDodVerification,
  runMarkDodVerificationSupervised,
  applyAndFinalizeMarkDod,
  type MarkDodResult,
} from '@/lib/workflows/phases/mark-dod-impl';

export type { MarkDodResult } from '@/lib/workflows/phases/mark-dod-impl';

/**
 * After review passes, verify which acceptance criteria in the linked GitHub
 * issue are *actually implemented* on the current branch — not just claimed —
 * then tick those boxes on the issue. Claude runs with read-only tools so it
 * can inspect the codebase rather than relying on a paper check of the diff.
 *
 * Failures are best-effort and never block the pipeline — returns ok:true with
 * changed:false on any recoverable error.
 */
export async function startMarkDod(
  projectName: string,
  override?: { issueNumber?: number; prNumber?: number; repo?: string },
): Promise<MarkDodResult> {
  const prep = await prepareMarkDod(projectName, override);
  if ('ok' in prep) return prep;
  const { bundle, job } = prep;

  try {
    const fetched = await fetchAndExtractMarkDodCriteria(bundle, job);
    if (fetched.terminal) return fetched.terminal;

    const branchSwitch = await switchBranchForMarkDodVerification(bundle, job);
    const verify = await runMarkDodVerificationSupervised(bundle, job, projectName, fetched);
    if (verify.terminal) return verify.terminal;

    return await applyAndFinalizeMarkDod(bundle, job, fetched, verify, branchSwitch);
  } catch (e) {
    const { markDone } = await import('@/lib/jobs/job-storage');
    await markDone(job, 1);
    return { ok: false, status: 500, detail: `mark-dod failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
