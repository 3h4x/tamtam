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
import {
  persistQuotaSnapshot,
  readPersistedQuotaSnapshot,
  type PersistableQuotaProvider,
} from '@/lib/usage/quota-store';

function isCodexProvider(): boolean {
  try {
    return getActiveCliProvider(getSettings()) === 'codex';
  } catch {
    return false;
  }
}

export type QuotaProvider = 'active' | 'claude' | 'codex';

export async function getQuota(options: { force?: boolean } = {}): Promise<QuotaSnapshot> {
  const snap = isCodexProvider() ? await getCodexQuota(options) : await getClaudeQuota(options);
  persistQuotaSnapshot(snap);
  return snap;
}

export async function getQuotaForProvider(
  provider: QuotaProvider = 'active',
  options: { force?: boolean } = {},
): Promise<QuotaSnapshot> {
  if (provider === 'codex') { const s = await getCodexQuota(options); persistQuotaSnapshot(s); return s; }
  if (provider === 'claude') { const s = await getClaudeQuota(options); persistQuotaSnapshot(s); return s; }
  return getQuota(options);
}

/**
 * Last persisted snapshot for a provider (DB-backed), resolving 'active' to the
 * configured CLI. Used to serve last-known values when the live fetch is
 * unavailable and the in-memory cache is cold (e.g. right after a restart).
 */
export async function readPersistedSnapshotForProvider(
  provider: QuotaProvider = 'active',
): Promise<QuotaSnapshot | null> {
  const concrete: PersistableQuotaProvider = provider === 'active'
    ? (isCodexProvider() ? 'codex' : 'claude')
    : provider;
  return readPersistedQuotaSnapshot(concrete);
}

export function clearQuotaCache(): void {
  if (isCodexProvider()) clearCodexQuotaCache();
  else clearClaudeQuotaCache();
}

export function peekQuotaCache(): QuotaSnapshot | null {
  return isCodexProvider() ? peekCodexQuotaCache() : peekClaudeQuotaCache();
}

export function peekQuotaCacheForProvider(provider: QuotaProvider = 'active'): QuotaSnapshot | null {
  if (provider === 'codex') return peekCodexQuotaCache();
  if (provider === 'claude') return peekClaudeQuotaCache();
  return peekQuotaCache();
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
        getClaudeQuota(options).then((s) => { persistQuotaSnapshot(s); out.set(provider, s); }).catch(() => { out.set(provider, null); }),
      );
    } else if (provider === 'codex') {
      tasks.push(
        getCodexQuota(options).then((s) => { persistQuotaSnapshot(s); out.set(provider, s); }).catch(() => { out.set(provider, null); }),
      );
    } else {
      // No fetcher today — treat as null so the picker uses 0% utilization.
      out.set(provider, null);
    }
  }
  await Promise.all(tasks);
  return out;
}

/**
 * Like {@link peekQuotaSnapshots} but resilient: when a provider's in-memory
 * snapshot is cold (null), fall back to the last DB-persisted snapshot (marked
 * stale) so it still appears in pace / globalPace after a restart or while the
 * upstream is rate-limited.
 */
export async function readResilientSnapshots(
  providers: CliProvider[],
): Promise<Map<CliProvider, QuotaSnapshot | null>> {
  const out = new Map<CliProvider, QuotaSnapshot | null>();
  for (const provider of providers) {
    const live = provider === 'claude'
      ? peekClaudeQuotaCache()
      : provider === 'codex'
        ? peekCodexQuotaCache()
        : null;
    if (live) { out.set(provider, live); continue; }
    if (provider === 'claude' || provider === 'codex') {
      const persisted = await readPersistedQuotaSnapshot(provider);
      out.set(provider, persisted ? { ...persisted, stale: true } : null);
    } else {
      out.set(provider, null);
    }
  }
  return out;
}
