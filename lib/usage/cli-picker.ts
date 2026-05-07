import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { ModelTier } from '@/lib/agents/model-aliases';

export interface PickCliOptions {
  enabled: CliProvider[];
  snapshots: Map<CliProvider, QuotaSnapshot | null>;
  budgetBlockAtPct: number;
  blockEnabled: boolean;
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
 *   - 5h rolling window utilization
 *   - credits/extra utilization, when the provider exposes a credits pool
 */
export function hardGateUtilizationFor(snapshot: QuotaSnapshot | null): number {
  if (!snapshot) return 0;
  const fiveHour = finiteOrZero(snapshot.fiveHour?.utilization);
  const credits = finiteOrZero(snapshot.extra?.utilization);
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
 */
export function pickCliProvider(opts: PickCliOptions): PickCliResult {
  const { enabled, snapshots, budgetBlockAtPct, blockEnabled, requestedModel } = opts;
  if (enabled.length === 0) {
    return { provider: null, reason: 'no_enabled_providers' };
  }
  const hasKnownQuotaAwareProvider = enabled.some((provider) =>
    hasQuotaFetcher(provider) && !!(snapshots.get(provider) ?? null)
  );
  let bestProvider: CliProvider | null = null;
  let bestHeadroom = -Infinity;
  let bestUtilization = 0;
  for (const provider of enabled) {
    const snapshot = snapshots.get(provider) ?? null;
    const hardGateUtilization = hardGateUtilizationFor(snapshot);
    if (blockEnabled && hardGateUtilization >= budgetBlockAtPct) continue;
    const utilization = !snapshot && hasKnownQuotaAwareProvider && hasQuotaFetcher(provider)
      ? 100
      : effectiveUtilizationFor(snapshot, requestedModel);
    const headroom = 100 - utilization;
    if (headroom > bestHeadroom) {
      bestProvider = provider;
      bestHeadroom = headroom;
      bestUtilization = utilization;
    }
  }
  if (bestProvider === null) {
    return { provider: null, reason: 'all_blocked' };
  }
  return { provider: bestProvider, utilization: bestUtilization };
}
