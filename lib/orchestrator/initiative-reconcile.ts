// Pure reconcile pass: for each running initiative that has a stored jobId,
// look up the job outcome and mark the initiative shipped or failed. A stored
// agent job id is only the pre-release association: agent success means "wait
// for release-after-run to link the release", not shipped.
// Injected deps keep this testable without a real DB or job store.

import type { InitiativeRow } from '@/lib/orchestrator/initiatives-store';

export type RunOutcome = 'running' | 'success' | 'failed' | 'unknown';
export type LinkedJobKind = 'agent' | 'release' | 'other' | 'unknown';

export interface ReconcileDeps {
  listRunning: (project: string) => Promise<InitiativeRow[]>;
  jobStatus: (jobId: string) => Promise<RunOutcome>;
  jobKind?: (jobId: string) => Promise<LinkedJobKind> | LinkedJobKind;
  markOutcome: (id: number, outcome: 'shipped' | 'failed', jobId: string | null) => Promise<void>;
  now?: () => number;
  staleMs?: number;
}

export async function reconcileRunningInitiatives(project: string, deps: ReconcileDeps): Promise<void> {
  const rows = await deps.listRunning(project);

  for (const row of rows) {
    try {
      const isStale =
        deps.now !== undefined &&
        deps.staleMs !== undefined &&
        (deps.now() - row.updatedAt) > deps.staleMs;

      if (row.releaseId === null) {
        // No jobId captured yet — apply stale backstop if configured
        if (isStale) {
          await deps.markOutcome(row.id, 'failed', row.releaseId);
        }
        continue;
      }

      const [outcome, kind] = await Promise.all([
        deps.jobStatus(row.releaseId),
        Promise.resolve(deps.jobKind ? deps.jobKind(row.releaseId) : 'release'),
      ]);

      if (outcome === 'success' && kind === 'release') {
        await deps.markOutcome(row.id, 'shipped', row.releaseId);
      } else if (outcome === 'success' && kind === 'agent') {
        // The agent produced work and returned successfully; the release
        // trigger will replace releaseId with the release meta-job id once it
        // starts. Until then, the initiative is still running.
        continue;
      } else if (outcome === 'failed') {
        await deps.markOutcome(row.id, 'failed', row.releaseId);
      } else if (outcome === 'unknown' && isStale) {
        // Pruned job row or any gap — free the dedupKey so the chore can be re-mined
        await deps.markOutcome(row.id, 'failed', row.releaseId);
      }
      // 'running' | ('unknown' && not stale) → leave untouched
    } catch {
      // Isolate: one initiative failure must not abort the rest
    }
  }
}
