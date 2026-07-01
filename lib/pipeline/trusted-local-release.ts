// Resolves whether the currently-active release (the one whose phase is running
// right now) was triggered by a trusted in-process agent run, and therefore may
// execute host-side test/review commands on its uncommitted working tree.
//
// The signal is persisted on the release meta-job's `contextMeta`
// (`trustedLocalChanges: true`, set in `start-release.ts`) and read here through
// the `parentContext` AsyncLocalStorage that every phase runs inside
// (`runWithParent(releaseJobId, …)`). Reading it from the release row — rather
// than threading a boolean through every phase-dispatch call site — means the
// orchestrator-driven re-runs (test→fix→test, review→fix→review) honour the
// same trust posture as the first phase without extra plumbing.

import { parentContext } from '@/lib/jobs/parent-context';
import { getJob } from '@/lib/jobs/job-storage';

export function activeReleaseAllowsTrustedLocalChanges(): boolean {
  try {
    const parentId = parentContext.getStore();
    if (!parentId) return false;
    const parent = getJob(parentId);
    if (!parent) return false;
    // Phases are parented directly to the release meta-job, but resolve through
    // `releaseId` defensively in case a deeper child is the active parent.
    const release = parent.kind === 'release'
      ? parent
      : (parent.releaseId ? getJob(parent.releaseId) : null);
    if (!release || release.kind !== 'release' || !release.contextMeta) return false;
    const meta = JSON.parse(release.contextMeta) as unknown;
    return !!meta && typeof meta === 'object' && (meta as Record<string, unknown>).trustedLocalChanges === true;
  } catch {
    return false;
  }
}
