import { getJob } from '@/lib/jobs/storage';
import { jobsPausedResult } from '@/lib/shared/job-control';
import { getSettings } from '@/lib/shared/config';
import { getQuotaSnapshots } from '@/lib/usage/quota';
import { pickCliProvider, effectiveUtilizationFor, type PickCliResult } from '@/lib/usage/cli-picker';
import { isCliProvider, type CliProvider } from '@/lib/usage/cli-providers';

export interface ResolveProviderOptions {
  /** Inherit from this parent job's `provider` if set (pipeline children). */
  parentJobId?: string | null;
  /** Agent's stored preference, or explicit override from a route handler. */
  preferred?: string | null;
  /** Skip quota fetch + picker; useful in tests. */
  fallback?: CliProvider;
}

export type CliStartGateResult =
  | { ok: true; provider: CliProvider }
  | { ok: false; status: number; detail: string };

export const ALL_PROVIDERS_BLOCKED_DETAIL =
  'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.';

/**
 * Resolve which CLI provider should run a job. Order of precedence:
 *   1. parent's stored provider — pipeline children inherit
 *   2. caller-supplied `preferred`, if it's still in the enabled set and
 *      survives the current budget gate
 *   3. policy pick: most-remaining-quota among enabled, gated by budget
 *
 * Returns `{ provider: null, reason }` if every enabled provider is over
 * budget; callers should surface that as HTTP 429. If no providers are
 * enabled at all, falls back to the caller-provided `fallback` (or
 * `'claude'` as a last resort) so install-time defaults still work.
 */
export async function resolveProviderForRun(
  opts: ResolveProviderOptions = {},
): Promise<PickCliResult> {
  if (opts.parentJobId) {
    const parent = getJob(opts.parentJobId);
    const inherited = parent?.provider;
    if (typeof inherited === 'string' && isCliProvider(inherited)) {
      return { provider: inherited };
    }
  }

  const settings = getSettings();
  // Tolerate older / mocked settings that omit the new cli_enabled_providers
  // key — fall back to the legacy `claude_provider` if present, else claude.
  const rawEnabled = (settings.cli_enabled_providers ?? null) as CliProvider[] | null;
  const enabled = rawEnabled && rawEnabled.length > 0
    ? rawEnabled
    : isCliProvider(settings.claude_provider)
      ? [settings.claude_provider as CliProvider]
      : ['claude' as CliProvider];

  if (enabled.length === 0) {
    return { provider: opts.fallback ?? 'claude' };
  }

  const preferred = opts.preferred && isCliProvider(opts.preferred) && enabled.includes(opts.preferred)
    ? opts.preferred
    : null;

  if (preferred && !settings.budget_block_runs_enabled) {
    return { provider: preferred };
  }

  // Fast path: only one enabled CLI → no need to fetch quotas to compare.
  // Budget gate can still kick in via the existing `runGates` helper at the
  // top of each route, so this is safe.
  if (enabled.length === 1 && !settings.budget_block_runs_enabled) {
    return { provider: enabled[0] };
  }

  const snapshots = await getQuotaSnapshots(enabled);
  if (preferred) {
    const preferredUtilization = effectiveUtilizationFor(snapshots.get(preferred) ?? null);
    if (preferredUtilization < (settings.budget_block_at_pct ?? 95)) {
      return { provider: preferred, utilization: preferredUtilization };
    }
  }
  return pickCliProvider({
    enabled,
    snapshots,
    budgetBlockAtPct: settings.budget_block_at_pct ?? 95,
    blockEnabled: !!settings.budget_block_runs_enabled,
  });
}

export async function checkCliStartGate(
  action: string,
  opts: ResolveProviderOptions = {},
): Promise<CliStartGateResult> {
  const paused = jobsPausedResult(action);
  if (paused) {
    return { ok: false, status: paused.status, detail: paused.detail };
  }
  const picked = await resolveProviderForRun(opts);
  if (!picked.provider) {
    return { ok: false, status: 429, detail: ALL_PROVIDERS_BLOCKED_DETAIL };
  }
  return { ok: true, provider: picked.provider };
}
