import { getJob } from '@/lib/jobs/storage';
import type { ModelTier } from '@/lib/agents/model-aliases';
import { jobsPausedResult } from '@/lib/shared/job-control';
import { getSettings } from '@/lib/shared/config';
import { getQuotaSnapshots } from '@/lib/usage/quota';
import { pickCliProvider, hardGateUtilizationFor, type PickCliResult } from '@/lib/usage/cli-picker';
import { isCliProvider, type CliProvider } from '@/lib/usage/cli-providers';

export interface ResolveProviderOptions {
  /** Inherit from this parent job's `provider` if set (pipeline children). */
  parentJobId?: string | null;
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
  const enabled = enabledProvidersFromSettings(settings);

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
    const preferredUtilization = hardGateUtilizationFor(snapshots.get(preferred) ?? null);
    if (preferredUtilization < (settings.budget_block_at_pct ?? 95)) {
      return { provider: preferred, utilization: preferredUtilization };
    }
  }
  return pickCliProvider({
    enabled,
    snapshots,
    budgetBlockAtPct: settings.budget_block_at_pct ?? 95,
    blockEnabled: !!settings.budget_block_runs_enabled,
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
  if (opts.strictPreferred && opts.preferred && isCliProvider(opts.preferred)) {
    const settings = getSettings();
    const enabled = enabledProvidersFromSettings(settings);
    const preferred = opts.preferred;
    if (!enabled.includes(preferred)) {
      return {
        ok: false,
        status: 409,
        detail: `Selected provider '${preferred}' is not enabled. Pick another provider or enable it in Settings → CLI.`,
      };
    }
    if (settings.budget_block_runs_enabled) {
      const snapshots = await getQuotaSnapshots([preferred]);
      const utilization = hardGateUtilizationFor(snapshots.get(preferred) ?? null);
      if (utilization >= (settings.budget_block_at_pct ?? 95)) {
        return {
          ok: false,
          status: 429,
          detail: `Selected provider '${preferred}' is over budget right now. Pick another provider or wait for its quota window to reset.`,
        };
      }
    }
    return { ok: true, provider: preferred };
  }
  const picked = await resolveProviderForRun(opts);
  if (!picked.provider) {
    return { ok: false, status: 429, detail: ALL_PROVIDERS_BLOCKED_DETAIL };
  }
  return { ok: true, provider: picked.provider };
}
