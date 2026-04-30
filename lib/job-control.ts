import * as internalScheduler from '@/lib/internal-scheduler';

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
  runtimeJobsPaused = paused;
  if (paused) internalScheduler.pauseInternalScheduler?.();
  else internalScheduler.resumeInternalScheduler?.();
}
