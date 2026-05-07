import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import { getActiveCliProvider, getSettings } from '@/lib/shared/config';
import {
  getClaudeQuota,
  clearQuotaCache as clearClaudeQuotaCache,
  peekQuotaCache as peekClaudeQuotaCache,
  prefetchQuota as prefetchClaudeQuota,
} from '@/lib/usage/claude-quota';
import {
  getCodexQuota,
  clearCodexQuotaCache,
  peekCodexQuotaCache,
  prefetchCodexQuota,
} from '@/lib/usage/codex-quota';
import { CLI_PROVIDERS_WITH_QUOTA, type CliProvider } from '@/lib/usage/cli-providers';

function isCodexProvider(): boolean {
  try {
    return getActiveCliProvider(getSettings()) === 'codex';
  } catch {
    return false;
  }
}

export type QuotaProvider = 'active' | 'claude' | 'codex';

export async function getQuota(options: { force?: boolean } = {}): Promise<QuotaSnapshot> {
  return isCodexProvider() ? getCodexQuota(options) : getClaudeQuota(options);
}

export async function getQuotaForProvider(
  provider: QuotaProvider = 'active',
  options: { force?: boolean } = {},
): Promise<QuotaSnapshot> {
  if (provider === 'codex') return getCodexQuota(options);
  if (provider === 'claude') return getClaudeQuota(options);
  return getQuota(options);
}

export function clearQuotaCache(): void {
  if (isCodexProvider()) clearCodexQuotaCache();
  else clearClaudeQuotaCache();
}

export function peekQuotaCache(): QuotaSnapshot | null {
  return isCodexProvider() ? peekCodexQuotaCache() : peekClaudeQuotaCache();
}

/**
 * Synchronous peek over a list of providers — returns the cached snapshot for
 * each (or null if no fetcher / cache cold). Used by the scheduler's
 * multi-provider gate so it doesn't block when one provider has headroom.
 */
export function peekQuotaSnapshots(
  providers: CliProvider[],
): Map<CliProvider, QuotaSnapshot | null> {
  const out = new Map<CliProvider, QuotaSnapshot | null>();
  for (const provider of providers) {
    if (provider === 'claude') out.set(provider, peekClaudeQuotaCache());
    else if (provider === 'codex') out.set(provider, peekCodexQuotaCache());
    else out.set(provider, null);
  }
  return out;
}

export function prefetchQuota(): void {
  if (isCodexProvider()) prefetchCodexQuota();
  else prefetchClaudeQuota();
}

export function prefetchQuotaProviders(providers: CliProvider[]): void {
  const seen = new Set<CliProvider>();
  for (const provider of providers) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    if (!CLI_PROVIDERS_WITH_QUOTA.includes(provider)) continue;
    if (provider === 'claude') prefetchClaudeQuota();
    if (provider === 'codex') prefetchCodexQuota();
  }
}

/**
 * Fetch quota snapshots for the given providers in parallel. Providers
 * without a fetcher (gemini, lmstudio) and any fetcher failure resolve to
 * `null` so callers can treat them as "unknown / always-available". Cached
 * upstream by each provider's fetcher.
 */
export async function getQuotaSnapshots(
  providers: CliProvider[],
  options: { force?: boolean } = {},
): Promise<Map<CliProvider, QuotaSnapshot | null>> {
  const out = new Map<CliProvider, QuotaSnapshot | null>();
  const tasks: Promise<void>[] = [];
  for (const provider of providers) {
    if (provider === 'claude') {
      tasks.push(
        getClaudeQuota(options).then((s) => { out.set(provider, s); }).catch(() => { out.set(provider, null); }),
      );
    } else if (provider === 'codex') {
      tasks.push(
        getCodexQuota(options).then((s) => { out.set(provider, s); }).catch(() => { out.set(provider, null); }),
      );
    } else {
      // No fetcher today — treat as null so the picker uses 0% utilization.
      out.set(provider, null);
    }
  }
  await Promise.all(tasks);
  return out;
}
