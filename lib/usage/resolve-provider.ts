import { getJob } from '@/lib/jobs/storage';
import type { ModelTier } from '@/lib/agents/model-aliases';
import { jobsPausedResult, pauseJobsForQuotaExhaustion } from '@/lib/shared/job-control';
import { getSettings } from '@/lib/shared/config';
import { getQuotaSnapshots } from '@/lib/usage/quota';
import { pickCliProvider, hardGateUtilizationFor, type PickCliResult } from '@/lib/usage/cli-picker';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import { isCliProvider, type CliProvider } from '@/lib/usage/cli-providers';
import { computeWeeklyBurnThrottle } from '@/lib/shared/budget-throttle';

const PACE_OVERRIDE_URGENCY_PP_PER_HOUR = 1.0;

/** Compute (paceMargin / hoursLeft) for a snapshot's 7d window. Returns 0
 *  when data is missing. Used as the urgency signal that decides whether to
 *  override an agent's pinned provider. */
function urgencyPpPerHour(snapshot: QuotaSnapshot | null): number {
  if (!snapshot) return 0;
  const w = snapshot.sevenDay;
  const reset = w?.msUntilReset;
  if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= 0) return 0;
  const total = 7 * 24 * 60 * 60 * 1000;
  const elapsedPct = (1 - reset / total) * 100;
  const util = typeof w?.utilization === 'number' ? w.utilization : 0;
  const margin = elapsedPct - util;
  const hoursLeft = reset / (60 * 60 * 1000);
  return margin / Math.max(1, hoursLeft);
}

/** Pick the provider with the highest urgency (paceMargin per hour-left) if
 *  it exceeds the override threshold. Returns null when no provider is in
 *  "urgent enough to hijack a pinned preference" territory. */
function pickMostUrgentProvider(
  snapshots: Map<CliProvider, QuotaSnapshot | null>,
  enabled: CliProvider[],
): CliProvider | null {
  let best: CliProvider | null = null;
  let bestUrgency = 0;
  for (const p of enabled) {
    const u = urgencyPpPerHour(snapshots.get(p) ?? null);
    if (u > bestUrgency) {
      best = p;
      bestUrgency = u;
    }
  }
  return bestUrgency >= PACE_OVERRIDE_URGENCY_PP_PER_HOUR ? best : null;
}

export interface ResolveProviderOptions {
  /** Inherit from this parent job's `provider` if set (pipeline children). */
  parentJobId?: string | null;
  /** When true, do not repick if the parent provider is disabled or blocked. */
  strictParentProvider?: boolean;
  /** Agent's stored preference, or explicit override from a route handler. */
  preferred?: string | null;
  /** When true, do not fall back to another provider if `preferred` cannot run. */
  strictPreferred?: boolean;
  /** Semantic model tier for this launch, when known up front. */
  requestedModel?: ModelTier | null;
  /** Skip quota fetch + picker; useful in tests. */
  fallback?: CliProvider;
  /** Defaults to true; set false only for explicit manual bypasses. */
  respectJobsPaused?: boolean;
  /** When true, providers whose 7-day utilization is projected to exceed
   *  quota are skipped in the picker. Set only for scheduled (cron) fires —
   *  manual/UI starts must not be blocked on a pace projection alone. */
  isScheduled?: boolean;
}

export type CliStartGateResult =
  | { ok: true; provider: CliProvider }
  | { ok: false; status: number; detail: string };

export const ALL_PROVIDERS_BLOCKED_DETAIL =
  'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.';

function enabledProvidersFromSettings(settings: ReturnType<typeof getSettings>): CliProvider[] {
  const rawEnabled = (settings.cli_enabled_providers ?? null) as CliProvider[] | null;
  return rawEnabled && rawEnabled.length > 0
    ? rawEnabled
    : isCliProvider(settings.claude_provider)
      ? [settings.claude_provider as CliProvider]
      : ['claude' as CliProvider];
}

/**
 * Resolve which CLI provider should run a job. Order of precedence:
 *   1. parent's stored provider — pipeline children inherit while it is runnable
 *   2. caller-supplied `preferred`, if it's still in the enabled set and
 *      survives the current budget gate
 *   3. policy pick: pace-aware provider choice among enabled, gated by budget
 *
 * Returns `{ provider: null, reason }` if every enabled provider is over
 * budget; callers should surface that as HTTP 429. If no providers are
 * enabled at all, falls back to the caller-provided `fallback` (or
 * `'claude'` as a last resort) so install-time defaults still work.
 */
export async function resolveProviderForRun(
  opts: ResolveProviderOptions = {},
): Promise<PickCliResult> {
  const settings = getSettings();
  // Tolerate older / mocked settings that omit the new cli_enabled_providers
  // key — fall back to the legacy `claude_provider` if present, else claude.
  const enabled = enabledProvidersFromSettings(settings);

  if (opts.parentJobId) {
    const parent = getJob(opts.parentJobId);
    const inherited = parent?.provider;
    if (typeof inherited === 'string' && isCliProvider(inherited)) {
      if (!enabled.includes(inherited)) {
        if (opts.strictParentProvider) {
          return { provider: null, reason: 'parent_provider_unavailable' };
        }
        return { provider: inherited };
      }
      if (enabled.length <= 1 && !opts.strictParentProvider) {
        return { provider: inherited };
      }
      try {
        const snapshots = await getQuotaSnapshots(enabled);
        const includeWeekly = !!settings.budget_block_on_weekly_pace_enabled;
        const inheritedUtilization = hardGateUtilizationFor(snapshots.get(inherited) ?? null, { includeWeekly });
        if (inheritedUtilization < (settings.budget_block_at_pct ?? 95)) {
          return { provider: inherited, utilization: inheritedUtilization };
        }
        if (opts.strictParentProvider) {
          return { provider: null, reason: 'parent_provider_blocked' };
        }
        return pickCliProvider({
          enabled,
          snapshots,
          budgetBlockAtPct: settings.budget_block_at_pct ?? 95,
          blockEnabled: true,
          blockOnWeeklyPace: includeWeekly,
          blockOnProjectedWeekly: !!opts.isScheduled && includeWeekly,
          requestedModel: opts.requestedModel ?? null,
        });
      } catch {
        return { provider: inherited };
      }
    }
  }

  if (enabled.length === 0) {
    return { provider: opts.fallback ?? 'claude' };
  }

  const preferred = opts.preferred && isCliProvider(opts.preferred) && enabled.includes(opts.preferred)
    ? opts.preferred
    : null;

  if (preferred && !settings.budget_block_runs_enabled) {
    // Pace-aware override: when another enabled provider's 7d window is
    // running out and far behind expected pace, hijack the preferred pin
    // so we actually use the budget that's about to expire. See
    // docs/SETTINGS.md → "Pace-aware provider routing".
    try {
      const snapshots = await getQuotaSnapshots(enabled);
      const preferredUtilization = hardGateUtilizationFor(snapshots.get(preferred) ?? null, {
        includeWeekly: !!settings.budget_block_on_weekly_pace_enabled,
      });
      if (preferredUtilization >= (settings.budget_block_at_pct ?? 95)) {
        return pickCliProvider({
          enabled,
          snapshots,
          budgetBlockAtPct: settings.budget_block_at_pct ?? 95,
          blockEnabled: true,
          blockOnWeeklyPace: !!settings.budget_block_on_weekly_pace_enabled,
          blockOnProjectedWeekly: !!opts.isScheduled && !!settings.budget_block_on_weekly_pace_enabled,
          requestedModel: opts.requestedModel ?? null,
        });
      }
      const urgent = pickMostUrgentProvider(snapshots, enabled);
      if (urgent && urgent !== preferred) {
        return { provider: urgent, reason: 'pace_override' };
      }
    } catch {
      /* fall through to preferred */
    }
    return { provider: preferred };
  }

  // Fast path: only one enabled CLI → no need to fetch quotas to compare.
  // Budget gate can still kick in via the existing `runGates` helper at the
  // top of each route, so this is safe.
  if (enabled.length === 1 && !settings.budget_block_runs_enabled && enabled[0] !== 'claude' && enabled[0] !== 'codex') {
    return { provider: enabled[0] };
  }

  const snapshots = await getQuotaSnapshots(enabled);
  const includeWeekly = !!settings.budget_block_on_weekly_pace_enabled;
  if (preferred) {
    const preferredUtilization = hardGateUtilizationFor(snapshots.get(preferred) ?? null, { includeWeekly });
    if (preferredUtilization < (settings.budget_block_at_pct ?? 95)) {
      return { provider: preferred, utilization: preferredUtilization };
    }
  }
  return pickCliProvider({
    enabled,
    snapshots,
    budgetBlockAtPct: settings.budget_block_at_pct ?? 95,
    blockEnabled: true,
    blockOnWeeklyPace: includeWeekly,
    blockOnProjectedWeekly: !!opts.isScheduled && includeWeekly,
    requestedModel: opts.requestedModel ?? null,
  });
}

export async function checkCliStartGate(
  action: string,
  opts: ResolveProviderOptions = {},
): Promise<CliStartGateResult> {
  if (opts.respectJobsPaused ?? true) {
    const paused = jobsPausedResult(action);
    if (paused) {
      return { ok: false, status: paused.status, detail: paused.detail };
    }
  }
  if (opts.strictParentProvider && opts.parentJobId) {
    const parent = getJob(opts.parentJobId);
    const inherited = parent?.provider;
    if (typeof inherited === 'string' && isCliProvider(inherited)) {
      return checkStrictProviderStart(inherited, 'Inherited', 'continue this provider-scoped session', {
        isScheduled: !!opts.isScheduled,
      });
    }
  }
  if (opts.strictPreferred && opts.preferred && isCliProvider(opts.preferred)) {
    return checkStrictProviderStart(opts.preferred, 'Selected', 'start with this provider', {
      isScheduled: !!opts.isScheduled,
    });
  }
  const picked = await resolveProviderForRun(opts);
  if (!picked.provider) {
    // Only auto-pause the global job switch when the user has opted into
    // budget gating. With `budget_block_runs_enabled=false` a transient null
    // (e.g. one provider's quota snapshot momentarily missing) used to flip
    // the global pause and freeze every project until a human cleared it;
    // surface the 429 to the caller but leave the switch alone.
    if (getSettings().budget_block_runs_enabled) {
      await pauseJobsForQuotaExhaustion(ALL_PROVIDERS_BLOCKED_DETAIL);
    }
    return { ok: false, status: 429, detail: ALL_PROVIDERS_BLOCKED_DETAIL };
  }
  return { ok: true, provider: picked.provider };
}

async function checkStrictProviderStart(
  provider: CliProvider,
  label: 'Selected' | 'Inherited',
  actionHint: string,
  options: { isScheduled?: boolean } = {},
): Promise<CliStartGateResult> {
  const settings = getSettings();
  const enabled = enabledProvidersFromSettings(settings);
  if (!enabled.includes(provider)) {
    return {
      ok: false,
      status: 409,
      detail: `${label} provider '${provider}' is not enabled. Pick another provider or enable it in Settings → CLI.`,
    };
  }
  const snapshots = await getQuotaSnapshots([provider]);
  const snapshot = snapshots.get(provider) ?? null;
  const includeWeekly = !!settings.budget_block_on_weekly_pace_enabled;
  const utilization = hardGateUtilizationFor(snapshot, { includeWeekly });
  if (utilization >= (settings.budget_block_at_pct ?? 95)) {
    return {
      ok: false,
      status: 429,
      detail: `${label} provider '${provider}' is over budget right now. Wait for its quota window to reset before trying to ${actionHint}.`,
    };
  }
  if (options.isScheduled && includeWeekly && snapshot && computeWeeklyBurnThrottle(snapshot.sevenDay)) {
    return {
      ok: false,
      status: 429,
      detail: `${label} provider '${provider}' is over budget right now. Wait for its quota window to reset before trying to ${actionHint}.`,
    };
  }
  return { ok: true, provider };
}
