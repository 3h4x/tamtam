import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { ModelTier } from '@/lib/agents/model-aliases';
import { computeWeeklyBurnThrottle } from '@/lib/shared/budget-throttle';

export interface PickCliOptions {
  enabled: CliProvider[];
  snapshots: Map<CliProvider, QuotaSnapshot | null>;
  budgetBlockAtPct: number;
  blockEnabled: boolean;
  /** When true, the hard gate includes current 7-day utilization too, so a
   *  provider at 99% weekly usage is treated as blocked even if its 5h
   *  burst is fine. Opt in via the `budget_block_on_weekly_pace_enabled`
   *  setting. */
  blockOnWeeklyPace?: boolean;
  /** When true, a provider whose 7-day utilization is projected to exceed
   *  100% by window reset is skipped in favour of providers still under
   *  pace.  Intended for scheduled (cron) fires only — manual/UI starts
   *  must not be rejected based on a pace projection alone. */
  blockOnProjectedWeekly?: boolean;
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
 * These are the only signals that can 429 a manual/root start:
 *   - 5h rolling window utilization (immediate burst quota)
 *   - credits/extra utilization, when the provider exposes a credits pool
 *   - current 7d utilization, when weekly hard gating is enabled
 *
 * When `includeWeekly` is true (opt-in via `budget_block_on_weekly_pace_enabled`),
 * the gate also includes current 7-day utilization. Projected weekly burn is
 * intentionally reserved for scheduled-work throttling so manual/root starts do
 * not 429 on pace projection alone.
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
  const { enabled, snapshots, budgetBlockAtPct, blockEnabled, blockOnWeeklyPace, blockOnProjectedWeekly, requestedModel } = opts;
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
    // Scheduled-fire gate: if this provider's 7d window is projected to
    // exceed quota before reset, skip it so the fire routes to a provider
    // that's still under pace. `computeWeeklyBurnThrottle` applies the same
    // stability guards (min elapsed, early-usage threshold) used elsewhere.
    if (blockOnProjectedWeekly && snapshot && computeWeeklyBurnThrottle(snapshot.sevenDay)) continue;
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
    // Near-cap penalty: when a provider's 5h window is *projected* to land
    // above 80% of its quota at end-of-window, taper the score so traffic
    // shifts to the other provider before we slam into the hard budget
    // block. Penalty grows linearly to ~full-urgency-cancel at 95%.
    // Projected = current_util × (100 / elapsedPct).
    //
    // Override: when the provider is materially behind on weekly pace
    // (paceMargin ≥ 15pp), suppress the 5h penalty. The whole point of the
    // weekly catch-up mode is to *use* the 5h headroom while we have it —
    // shifting traffic away from claude as its 5h fills up is exactly what
    // we don't want when claude/7d is the one we need to burn down.
    const fiveHourUtil = snapshot?.fiveHour?.utilization ?? 0;
    const fiveHourElapsed = snapshot?.fiveHour
      ? Math.max(1, (1 - (snapshot.fiveHour.msUntilReset ?? 1) / (5 * 60 * 60 * 1000)) * 100)
      : 100;
    const fiveHourProjected = fiveHourUtil * (100 / fiveHourElapsed);
    const weeklyCatchupMode = paceMargin >= 15 && fiveHourUtil < budgetBlockAtPct;
    const nearCapPenalty = fiveHourProjected > 80 && !weeklyCatchupMode
      ? Math.min(1, (fiveHourProjected - 80) / 15) * urgency
      : 0;
    // Headroom floor: a provider with <10pp of total quota left should not
    // win on weekly-catch-up urgency alone. Scale urgency by headroom/10 so a
    // provider at 95% (5pp headroom) keeps only half its urgency, and one at
    // 100% loses all of it. This prevents the picker from routing to the
    // about-to-cap provider just because its remaining 3pp need to land in
    // the last 3h of the week.
    const HEADROOM_FLOOR = 10;
    const headroomFactor = Math.min(1, Math.max(0, headroom) / HEADROOM_FLOOR);
    const adjustedUrgency = (urgency - nearCapPenalty) * headroomFactor;
    const score = adjustedUrgency * 1000 + headroom / 100;
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
