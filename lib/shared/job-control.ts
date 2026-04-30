import * as internalScheduler from '@/lib/scheduling/internal-scheduler';

export type JobsPausedResult = { ok: false; status: 409; detail: string };

let runtimeJobsPaused = false;

export function isJobsPaused(): boolean {
  return runtimeJobsPaused;
}

export function jobsPausedResult(action = 'start new jobs'): JobsPausedResult | null {
  if (!isJobsPaused()) return null;
  return {
    ok: false,
    status: 409,
    detail: `Jobs are paused globally. Turn the switch back on in Settings to ${action}.`,
  };
}

export function syncJobsPauseState(paused: boolean): void {
  const wasPaused = runtimeJobsPaused;
  runtimeJobsPaused = paused;
  if (paused) {
    internalScheduler.pauseInternalScheduler?.();
  } else {
    internalScheduler.resumeInternalScheduler?.();
    // Resume edge: drain any release queued while we were paused. Fire and
    // forget — drainPendingRelease is bounded and self-cleaning.
    if (wasPaused) void drainAllPendingReleasesAsync();
  }
}

async function drainAllPendingReleasesAsync(): Promise<void> {
  try {
    const { listPendingReleaseProjects, drainPendingRelease } = await import('@/lib/pipeline/pending-release');
    const projects = listPendingReleaseProjects();
    for (const p of projects) {
      try { await drainPendingRelease(p); } catch (e) { console.error('[resume] drain failed for', p, e); }
    }
  } catch (e) {
    console.error('[resume] failed to enumerate pending releases:', e);
  }
}
