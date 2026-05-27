import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { ModelTier } from '@/lib/agents/model-aliases';

export interface PickCliOptions {
  enabled: CliProvider[];
  snapshots: Map<CliProvider, QuotaSnapshot | null>;
  budgetBlockAtPct: number;
  blockEnabled: boolean;
  /** When true, the hard gate includes 7-day pace utilization too — so a
   *  provider at 99% weekly pace is treated as blocked even if its 5h
   *  burst is fine. Defaults to false to preserve historical "manual
   *  starts always go through" behavior; opt in via the
   *  `budget_block_on_weekly_pace_enabled` setting. */
  blockOnWeeklyPace?: boolean;
  requestedModel?: ModelTier | null;
}

export interface PickCliResult {
  provider: CliProvider | null;
  /** Reason the result is null, or the headroom of the chosen provider. */
  reason?: string;
  utilization?: number;
}

function finiteOrZero(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function hasQuotaFetcher(provider: CliProvider): boolean {
  return provider === 'claude' || provider === 'codex';
}

/**
 * Compute the hard-gate utilization (%) for a single provider snapshot.
 * This is the only signal that can 429 a manual/root start:
 *   - 5h rolling window utilization (immediate burst quota)
 *   - credits/extra utilization, when the provider exposes a credits pool
 *
 * The 7d window is deliberately not a hard gate for manual/root starts. It is
 * used for provider preference and scheduled-work throttling, where pacing the
 * weekly quota is useful without blocking explicit user actions for days.
 */
export function hardGateUtilizationFor(
  snapshot: QuotaSnapshot | null,
  options: { includeWeekly?: boolean } = {},
): number {
  if (!snapshot) return 0;
  const fiveHour = finiteOrZero(snapshot.fiveHour?.utilization);
  const credits = finiteOrZero(snapshot.extra?.utilization);
  if (options.includeWeekly) {
    const sevenDay = finiteOrZero(snapshot.sevenDay?.utilization);
    return Math.max(fiveHour, sevenDay, credits);
  }
  return Math.max(fiveHour, credits);
}

/**
 * Compute the advisory utilization (%) for provider preference.
 * Considers the broader quota signals exposed by the CLIs:
 *   - 5h rolling window utilization
 *   - 7d rolling window utilization
 *   - provider-specific model weekly windows, when available
 *   - credits/extra utilization, when the provider exposes a credits pool
 *
 * Providers without a snapshot (gemini, lmstudio, fetcher errors) report 0
 * so they always look fully available — the picker treats them as fallback
 * options that are never blocked by the gate.
 */
export function effectiveUtilizationFor(
  snapshot: QuotaSnapshot | null,
  requestedModel?: ModelTier | null,
): number {
  if (!snapshot) return 0;
  const fiveHour = hardGateUtilizationFor(snapshot);
  const sevenDay = finiteOrZero(snapshot.sevenDay?.utilization);
  const modelWeekly =
    requestedModel === 'normal'
      ? finiteOrZero(snapshot.sevenDaySonnet?.utilization)
      : requestedModel === 'smart'
        ? finiteOrZero(snapshot.sevenDayOpus?.utilization)
        : 0;
  return Math.max(fiveHour, sevenDay, modelWeekly);
}

/**
 * Pick the enabled CLI with the most remaining quota headroom. Only the
 * hard-gate utilization can block a manual/root start; weekly windows still
 * influence preference among otherwise healthy providers. Tie-breaks by the
 * order of `enabled`. Returns null if every enabled provider is blocked.
 *
 * When at least one quota-aware provider has a known snapshot, another
 * quota-aware provider with a missing snapshot is treated as unavailable
 * rather than as an "unknown but maybe healthy" fallback. This keeps the
 * route-level start gate aligned with the scheduler's synchronous
 * multi-provider budget verdicts after warm/fetch attempts.
 */
function paceMarginPctFor(snapshot: QuotaSnapshot | null): number {
  // paceMargin = how far below the steady 7-day burn line this provider is.
  // Higher = more behind = more catch-up needed. Computed from the 7d window
  // since that's where weekly pacing actually matters; the 5h window is too
  // bursty to drive routing.
  if (!snapshot) return 0;
  const w = snapshot.sevenDay;
  const reset = w?.msUntilReset;
  const total = 7 * 24 * 60 * 60 * 1000;
  if (typeof reset !== 'number' || !Number.isFinite(reset) || total <= 0) return 0;
  const elapsedPct = Math.max(0, Math.min(100, (1 - reset / total) * 100));
  const util = finiteOrZero(w?.utilization);
  return elapsedPct - util;
}

function hoursLeftInWindowFor(snapshot: QuotaSnapshot | null): number {
  // Time remaining in the 7d window — drives urgency weighting. A provider
  // with 24h left and 35pp behind is FAR more urgent than another with 5
  // days left and the same margin: same catch-up budget, 5× less time.
  if (!snapshot) return 7 * 24;
  const reset = snapshot.sevenDay?.msUntilReset;
  if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= 0) return 7 * 24;
  return reset / (60 * 60 * 1000);
}

export function pickCliProvider(opts: PickCliOptions): PickCliResult {
  const { enabled, snapshots, budgetBlockAtPct, blockEnabled, blockOnWeeklyPace, requestedModel } = opts;
  if (enabled.length === 0) {
    return { provider: null, reason: 'no_enabled_providers' };
  }
  const hasKnownQuotaAwareProvider = enabled.some((provider) =>
    hasQuotaFetcher(provider) && !!(snapshots.get(provider) ?? null)
  );
  // Pace-aware routing (see docs/SETTINGS.md → "Pace-aware provider routing"):
  // primary key is paceMarginPct (most-behind first) so the under-pace
  // provider gets traffic; headroom is the tiebreak so a provider with no
  // remaining budget still loses to one that can actually run a job.
  let bestProvider: CliProvider | null = null;
  let bestScore = -Infinity;
  let bestUtilization = 0;
  for (const provider of enabled) {
    const snapshot = snapshots.get(provider) ?? null;
    const missingKnownQuotaAware =
      !snapshot && hasKnownQuotaAwareProvider && hasQuotaFetcher(provider);
    if (blockEnabled && missingKnownQuotaAware) continue;
    const hardGateUtilization = hardGateUtilizationFor(snapshot, { includeWeekly: blockOnWeeklyPace });
    if (blockEnabled && hardGateUtilization >= budgetBlockAtPct) continue;
    const utilization = missingKnownQuotaAware
      ? 100
      : effectiveUtilizationFor(snapshot, requestedModel);
    const headroom = 100 - utilization;
    const paceMargin = paceMarginPctFor(snapshot);
    const hoursLeft = Math.max(1, hoursLeftInWindowFor(snapshot));
    // Urgency-weighted score: paceMargin per hour-left drives the pick — a
    // provider 35pp behind with 24h left (1.46pp/h) beats one 35pp behind
    // with 5 days left (0.29pp/h) by ~5×. Headroom/100 stays as a sub-point
    // tiebreak so providers with effectively zero budget still lose.
    const urgency = paceMargin / hoursLeft;
    const score = urgency * 1000 + headroom / 100;
    if (score > bestScore) {
      bestProvider = provider;
      bestScore = score;
      bestUtilization = utilization;
    }
  }
  if (bestProvider === null) {
    return { provider: null, reason: 'all_blocked' };
  }
  return { provider: bestProvider, utilization: bestUtilization };
}
