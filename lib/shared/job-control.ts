// internal-scheduler.ts was retired with the in-memory cron path. Pause
// state is now read by the agent-cron task handler's `prereqSkipReason`
// callback (see lib/workflows/cron/agent-cron-task.ts) — no scheduler-
// side toggle needed because graphile-worker fires per-job and the
// handler can decide to skip in flight.
import { getActiveCliProvider, getSettings } from '@/lib/shared/config';
import {
  getQuotaSnapshots,
  peekQuotaCache,
  peekQuotaSnapshots,
  prefetchQuota,
  prefetchQuotaProviders,
} from '@/lib/usage/quota';
import { notify } from '@/lib/shared/notifications';
import { computeWeeklyBurnThrottle } from '@/lib/shared/budget-throttle';
import { hardGateUtilizationFor } from '@/lib/usage/cli-picker';
import { CLI_PROVIDERS_WITH_QUOTA, type CliProvider } from '@/lib/usage/cli-providers';

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
    throttleKeySuffix: `budget:${key}`,
    timestamp: now,
  });
}

export function syncJobsPauseState(paused: boolean): void {
  const wasPaused = runtimeJobsPaused;
  runtimeJobsPaused = paused;
  if (!paused && wasPaused) {
    // Resume edge: drain any release/agent work queued while we were paused,
    // preserving per-project "pending release before queued agent" ordering.
    // The agent-cron handler reads `runtimeJobsPaused` on each fire, so the
    // pause state itself doesn't need a scheduler-side toggle anymore.
    void drainAllRecoveryWorkAsync();
    void drainAllQueuedAgentsAsync();
  }
}

/**
 * Runs both the pause and budget gates for a pipeline route. Returns either a
 * JobsPausedResult or BudgetBlockedResult; null when both gates are clear.
 * Synchronous — both component checks are sync. Callers convert to a 409 or
 * 429 NextResponse (pause→409, budget→429) using `result.status` and `result.detail`.
 *
 * Multi-CLI note: with several providers enabled, this gate's budget check
 * (against the legacy "active" snapshot) can over-block — Claude full but
 * Codex available. Routes that route through `resolveProviderForRun` /
 * `pickCliProvider` should call `jobsPausedResult` instead and let the
 * picker handle per-provider budget enforcement.
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

function hasQuotaFetcher(provider: CliProvider): boolean {
  return CLI_PROVIDERS_WITH_QUOTA.includes(provider);
}

function getEnabledProviders(): CliProvider[] {
  try {
    const settings = getSettings();
    if (!settings) return [];
    const enabled = Array.isArray(settings.cli_enabled_providers)
      ? settings.cli_enabled_providers
      : [];
    if (enabled.length > 0) return enabled;
    return [getActiveCliProvider({
      cli_enabled_providers: enabled,
      claude_provider: settings.claude_provider,
    })];
  } catch {
    return [];
  }
}

export async function warmEnabledProviderSnapshots(
  options: { force?: boolean } = {},
): Promise<void> {
  const enabled = getEnabledProviders().filter(hasQuotaFetcher);
  if (enabled.length === 0) return;
  try {
    await getQuotaSnapshots(enabled, options);
  } catch {
    // fail open
  }
}

export interface SchedulerThrottle {
  reason: string;
  projectedPct: number;
  worstProvider: CliProvider;
  resumesAtMs: number | null;
}

/**
 * Multi-provider variant of `scheduledBurnRateBlocked`. Blocks the scheduler
 * ONLY when EVERY enabled provider's 7d burn projection trips. If any provider
 * still has weekly headroom (or has no quota fetcher and so counts as
 * "always available"), returns null and the picker handles the fan-out.
 *
 * Mirrors the per-provider availability rules used by the manual start path:
 * once any quota-aware provider has a known snapshot, another quota-aware
 * sibling with a missing snapshot no longer counts as available fallback.
 */
export function scheduledBurnRateBlockedAcrossProviders(): SchedulerThrottle | null {
  let cfg;
  try { cfg = getSettings(); } catch { return null; }
  if (!cfg?.budget_block_runs_enabled) return null;
  const enabled = getEnabledProviders();
  if (enabled.length === 0) return null;
  const snapshots = peekQuotaSnapshots(enabled);
  const hasKnownQuotaAwareProvider = enabled.some((provider) =>
    hasQuotaFetcher(provider) && !!(snapshots.get(provider) ?? null)
  );

  let worst: { provider: CliProvider; reason: string; projectedPct: number; resumesAtMs: number | null } | null = null;
  for (const provider of enabled) {
    if (!hasQuotaFetcher(provider)) {
      // Providers without quota fetchers are always eligible fallback targets.
      return null;
    }
    const snap = snapshots.get(provider) ?? null;
    if (!snap) {
      if (!hasKnownQuotaAwareProvider) return null;
      continue;
    }
    const burn = computeWeeklyBurnThrottle(snap.sevenDay);
    if (!burn) {
      // This provider has weekly headroom — the picker will route here.
      return null;
    }
    if (!worst || burn.projectedPct > worst.projectedPct) {
      worst = {
        provider,
        reason: burn.reason,
        projectedPct: burn.projectedPct,
        resumesAtMs: typeof burn.resumesAtMs === 'number' ? burn.resumesAtMs : null,
      };
    }
  }
  if (!worst) return null;
  return {
    reason: worst.reason,
    projectedPct: worst.projectedPct,
    worstProvider: worst.provider,
    resumesAtMs: worst.resumesAtMs,
  };
}

/**
 * Multi-provider variant of `budgetBlockedResult`. Returns null when at least
 * one enabled provider is under the 5h hard cap (the picker would route there).
 * Reports the worst-loaded provider when every enabled provider is blocked.
 * Missing snapshots from quota-aware providers are treated as unavailable once
 * a sibling quota-aware provider has a known snapshot, matching the manual
 * route gate after it fetches provider snapshots.
 */
export function budgetBlockedAcrossProviders(action = 'start new jobs'): BudgetBlockedResult | null {
  let cfg;
  try { cfg = getSettings(); } catch { return null; }
  if (!cfg?.budget_block_runs_enabled) return null;
  const enabled = getEnabledProviders();
  if (enabled.length === 0) return budgetBlockedResult(action);
  const limit = cfg.budget_block_at_pct;
  const snapshots = peekQuotaSnapshots(enabled);
  const quotaAwareProviders = enabled.filter(hasQuotaFetcher);
  const hasKnownQuotaAwareProvider = quotaAwareProviders.some((provider) => !!(snapshots.get(provider) ?? null));
  prefetchQuotaProviders(quotaAwareProviders);

  let worst: { snapshot: import('@/lib/usage/quota-types').QuotaSnapshot; util: number } | null = null;
  for (const provider of enabled) {
    if (!hasQuotaFetcher(provider)) {
      // No quota fetcher means this provider remains available for routing.
      return null;
    }
    const snap = snapshots.get(provider) ?? null;
    if (!snap) {
      if (!hasKnownQuotaAwareProvider) {
        prefetchQuota();
        return null;
      }
      continue;
    }
    const util = hardGateUtilizationFor(snap);
    if (util < limit) {
      // At least one provider has headroom — picker will route there.
      return null;
    }
    if (!worst || util > worst.util) worst = { snapshot: snap, util };
  }
  if (!worst) return null;
  // Every enabled provider is blocked — report the worst one through the
  // existing single-provider 5h/credits message format for consistency.
  const snapshot = worst.snapshot;
  const extraUtilization = snapshot.extra?.utilization;
  if (snapshot.extra?.isEnabled && typeof extraUtilization === 'number' && extraUtilization >= limit) {
    const provider = snapshot.provider === 'codex' ? 'Codex' : 'Claude';
    const detail = snapshot.provider === 'codex'
      ? `${provider} model credit gate blocked (${extraUtilization.toFixed(0)}%). Will resume when Codex reports model credits are available.`
      : `${provider} credits exhausted (${extraUtilization.toFixed(0)}%). Will resume when quota or credits are available.`;
    fireBudgetBlockedNotification('credits', extraUtilization, null, action);
    return { ok: false, status: 429, detail, window: 'credits', utilization: extraUtilization, resetsAt: null };
  }
  const win = snapshot.fiveHour;
  fireBudgetBlockedNotification('5h', win.utilization, win.resetsAt, action);
  const provider = snapshot.provider === 'codex' ? 'Codex' : 'Claude';
  const resumesLabel = win.resetsAt
    ? `Will resume after ${new Date(win.resetsAt).toLocaleTimeString()}.`
    : 'Will resume when quota or credits are available.';
  return {
    ok: false,
    status: 429,
    detail: `All enabled providers over budget; ${provider} 5h at ${win.utilization.toFixed(0)}%. ${resumesLabel}`,
    window: '5h',
    utilization: win.utilization,
    resetsAt: win.resetsAt,
  };
}

async function drainAllRecoveryWorkAsync(): Promise<void> {
  try {
    const { drainAllRecoveryWork } = await import('@/lib/pipeline/recovery-drain');
    await drainAllRecoveryWork('[resume]');
  } catch (e) {
    console.error('[resume] failed to drain queued recovery work:', e);
  }
}

async function drainAllQueuedAgentsAsync(): Promise<void> {
  try {
    const { listQueuedProjects, drainNextAgentRun } = await import('@/lib/agents/pending-agent-run');
    const projects = listQueuedProjects();
    // Drain in parallel — each project has its own queue and its own
    // in-flight guard inside `drainNextAgentRun`, so cross-project
    // parallelism is safe. Sequential awaits would have made resume
    // latency scale with project count.
    await Promise.allSettled(
      projects.map(async (project) => {
        try {
          await drainNextAgentRun(project);
        } catch (e) {
          console.error('[resume] agent drain failed for', project, e);
        }
      }),
    );
  } catch (e) {
    console.error('[resume] failed to enumerate queued agents:', e);
  }
}
