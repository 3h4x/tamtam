import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import type { CliProvider } from '@/lib/usage/cli-providers';

export interface PickCliOptions {
  enabled: CliProvider[];
  snapshots: Map<CliProvider, QuotaSnapshot | null>;
  budgetBlockAtPct: number;
  blockEnabled: boolean;
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

/**
 * Compute the worst-case utilization (%) for a single provider snapshot.
 * Considers the hard-gate signals shared by all manual/root entrypoints:
 *   - 5h rolling window utilization (hard short-term gate)
 *   - credits/extra utilization (when the provider exposes a credits pool)
 *
 * Providers without a snapshot (gemini, lmstudio, fetcher errors) report 0
 * so they always look fully available — the picker treats them as fallback
 * options that are never blocked by the gate.
 */
export function effectiveUtilizationFor(snapshot: QuotaSnapshot | null): number {
  if (!snapshot) return 0;
  const fiveHour = finiteOrZero(snapshot.fiveHour?.utilization);
  const credits = finiteOrZero(snapshot.extra?.utilization);
  return Math.max(fiveHour, credits);
}

/**
 * Pick the enabled CLI with the most remaining quota headroom. Skips any
 * provider whose snapshot already exceeds the budget block threshold when
 * the gate is enabled. Tie-breaks by the order of `enabled`. Returns null
 * if every enabled provider is blocked.
 */
export function pickCliProvider(opts: PickCliOptions): PickCliResult {
  const { enabled, snapshots, budgetBlockAtPct, blockEnabled } = opts;
  if (enabled.length === 0) {
    return { provider: null, reason: 'no_enabled_providers' };
  }
  let bestProvider: CliProvider | null = null;
  let bestHeadroom = -Infinity;
  let bestUtilization = 0;
  for (const provider of enabled) {
    const snapshot = snapshots.get(provider) ?? null;
    const utilization = effectiveUtilizationFor(snapshot);
    if (blockEnabled && utilization >= budgetBlockAtPct) continue;
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
