import * as internalScheduler from '@/lib/scheduling/internal-scheduler';
import { getSettings } from '@/lib/shared/config';
import { peekQuotaCache, prefetchQuota } from '@/lib/usage/quota';
import { notify } from '@/lib/shared/notifications';
import { computeWeeklyBurnThrottle } from '@/lib/shared/budget-throttle';

export type JobsPausedResult = { ok: false; status: 409; detail: string };
export type BudgetBlockedResult = {
  ok: false;
  status: 429;
  detail: string;
  window: '5h' | '7d' | 'credits';
  utilization: number;
  resetsAt: string | null;
};

let runtimeJobsPaused = false;

export function isJobsPaused(): boolean {
  if (runtimeJobsPaused) return true;
  try {
    return !!getSettings().jobs_paused;
  } catch {
    return false;
  }
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
 * Returns a 429 result when the configured Claude subscription budget threshold
 * is exceeded on the 5-hour rolling window. Synchronous: reads the in-memory
 * snapshot only. Triggers a background refresh on every call so the cache stays
 * warm. Fails OPEN (returns null) when no snapshot is cached — a cold-start or
 * transient API failure must not paralyse every pipeline.
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

  const extraUtilization = snapshot.extra?.utilization;
  if (snapshot.extra?.isEnabled && typeof extraUtilization === 'number' && extraUtilization >= limit) {
    const provider = snapshot.provider === 'codex' ? 'Codex' : 'Claude';
    const detail = snapshot.provider === 'codex'
      ? `${provider} model credit gate blocked (${extraUtilization.toFixed(0)}%). Will resume when Codex reports model credits are available.`
      : `${provider} credits exhausted (${extraUtilization.toFixed(0)}%). Will resume when quota or credits are available.`;
    fireBudgetBlockedNotification('credits', extraUtilization, null, action);
    return {
      ok: false,
      status: 429,
      detail,
      window: 'credits',
      utilization: extraUtilization,
      resetsAt: null,
    };
  }

  // Only the 5-hour rolling window gates pipeline actions. The 7-day window
  // is informational — for active users it's structurally always over-pace
  // and would otherwise wedge the pipeline for days at a time.
  const win = snapshot.fiveHour;
  if (win.utilization < limit) return null;
  fireBudgetBlockedNotification('5h', win.utilization, win.resetsAt, action);
  const provider = snapshot.provider === 'codex' ? 'Codex' : 'Claude';
  const resumesLabel = win.resetsAt
    ? `Will resume after ${new Date(win.resetsAt).toLocaleTimeString()}.`
    : 'Will resume when quota or credits are available.';
  return {
    ok: false,
    status: 429,
    detail: `${provider} quota exceeded (5h at ${win.utilization.toFixed(0)}%). ${resumesLabel}`,
    window: '5h',
    utilization: win.utilization,
    resetsAt: win.resetsAt,
  };
}

// Debounce: at most one webhook per window+resetsAt pair so a tight retry loop
// can't flood Slack/Discord. Keyed by `${window}:${resetsAt}` — when the reset
// timestamp rolls over, the next block will notify again.
const lastNotifiedKey = new Map<string, number>();
function fireBudgetBlockedNotification(
  window: '5h' | '7d' | 'credits',
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
 * Synchronous — both component checks are sync. Callers convert to a 409 or
 * 429 NextResponse (pause→409, budget→429) using `result.status` and `result.detail`.
 */
export function runGates(action = 'start new jobs'): JobsPausedResult | BudgetBlockedResult | null {
  const paused = jobsPausedResult(action);
  if (paused) return paused;
  return budgetBlockedResult(action);
}

/**
 * Gate for auto-chained pipeline re-entries (completion hooks).
 * Once a release is already in flight, the user's intent is test→fix→review
 * →commit→push. Keep hard gates (pause, 5h quota, credits), but do not apply
 * the scheduled-agent weekly burn projection mid-release.
 */
export function runAutoChainGates(action = 'continue pipeline'): JobsPausedResult | BudgetBlockedResult | null {
  return runGates(action);
}

/**
 * Burn-rate gate for *scheduled* (non-interactive) work only. Returns a reason
 * string when the 7-day window is on pace to exceed quota before reset, so the
 * caller (the internal scheduler) can skip the fire. Manual buttons ignore
 * this — humans can spend quota however they like; the goal is to stop
 * unattended cron from torching the weekly limit overnight.
 *
 * Fails OPEN when no snapshot is cached or the 7d reset timestamp is missing.
 */
export function scheduledBurnRateBlocked(): { reason: string; projectedPct: number } | null {
  let cfg;
  try { cfg = getSettings(); } catch { return null; }
  if (!cfg?.budget_block_runs_enabled) return null;
  const snapshot = peekQuotaCache();
  if (!snapshot) return null;
  const burn = computeWeeklyBurnThrottle(snapshot.sevenDay);
  if (!burn) return null;
  return { reason: burn.reason, projectedPct: burn.projectedPct };
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
