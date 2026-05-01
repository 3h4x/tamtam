import * as internalScheduler from '@/lib/scheduling/internal-scheduler';
import { getSettings } from '@/lib/shared/config';
import { peekQuotaCache, prefetchQuota } from '@/lib/usage/claude-quota';
import { notify } from '@/lib/shared/notifications';

export type JobsPausedResult = { ok: false; status: 409; detail: string };
export type BudgetBlockedResult = {
  ok: false;
  status: 409;
  detail: string;
  window: '5h' | '7d';
  utilization: number;
  resetsAt: string | null;
};

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

/**
 * Returns a 409 result when the configured Claude subscription budget threshold
 * is exceeded on either the 5-hour or 7-day window. Synchronous: reads the
 * in-memory snapshot only. Triggers a background refresh on every call so the
 * cache stays warm. Fails OPEN (returns null) when no snapshot is cached — a
 * cold-start or transient API failure must not paralyse every pipeline.
 */
export function budgetBlockedResult(action = 'start new jobs'): BudgetBlockedResult | null {
  let cfg;
  try {
    cfg = getSettings();
  } catch {
    return null;
  }
  if (!cfg?.budget_block_runs_enabled) return null;
  const limit = cfg.budget_block_at_pct;
  const snapshot = peekQuotaCache();
  // Refresh in background so the next call sees fresh data.
  prefetchQuota();
  if (!snapshot) return null;
  const offending =
    snapshot.fiveHour.utilization >= limit ? { window: '5h' as const, win: snapshot.fiveHour } :
    snapshot.sevenDay.utilization >= limit ? { window: '7d' as const, win: snapshot.sevenDay } :
    null;
  if (!offending) return null;
  fireBudgetBlockedNotification(offending.window, offending.win.utilization, offending.win.resetsAt, action);
  return {
    ok: false,
    status: 409,
    detail: `Claude subscription budget exceeded (${offending.window} at ${offending.win.utilization.toFixed(0)}%, limit ${limit}%). Wait for reset or raise threshold in Settings to ${action}.`,
    window: offending.window,
    utilization: offending.win.utilization,
    resetsAt: offending.win.resetsAt,
  };
}

// Debounce: at most one webhook per window+resetsAt pair so a tight retry loop
// can't flood Slack/Discord. Keyed by `${window}:${resetsAt}` — when the reset
// timestamp rolls over, the next block will notify again.
const lastNotifiedKey = new Map<string, number>();
function fireBudgetBlockedNotification(
  window: '5h' | '7d',
  utilization: number,
  resetsAt: string | null,
  action: string,
): void {
  const key = `${window}:${resetsAt ?? 'unknown'}`;
  const now = Date.now();
  const last = lastNotifiedKey.get(key) ?? 0;
  if (now - last < 60_000) return;
  lastNotifiedKey.set(key, now);
  void notify({
    event: 'budget_blocked',
    project: 'tamtam',
    job_id: '-',
    status: 'failed',
    message: `Subscription quota gate tripped: ${window} at ${utilization.toFixed(0)}% blocked attempt to ${action}. Resets ${resetsAt ?? 'unknown'}.`,
    timestamp: now,
  });
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

/**
 * Runs both the pause and budget gates for a pipeline route. Returns either a
 * JobsPausedResult or BudgetBlockedResult; null when both gates are clear.
 * Synchronous — both component checks are sync. Callers convert to a 409
 * NextResponse with `result.detail`.
 */
export function runGates(action = 'start new jobs'): JobsPausedResult | BudgetBlockedResult | null {
  const paused = jobsPausedResult(action);
  if (paused) return paused;
  return budgetBlockedResult(action);
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
