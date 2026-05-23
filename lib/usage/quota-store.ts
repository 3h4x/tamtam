import type { QuotaSnapshot } from '@/lib/usage/quota-types';

// Durable per-provider quota snapshots.
//
// The live quota fetchers (codex-quota / claude-quota) only keep an in-memory
// cache, which is lost on every restart. When the upstream is unavailable
// (Anthropic usage API rate-limited, CLI quota cold right after a rebuild) the
// route would otherwise return "unavailable" and the provider vanishes from
// pace / globalPace. Persisting the last good snapshot lets us serve the
// last-known values (marked stale) instead.
//
// Stored in the existing `settings` table (key = `quota_snapshot:<provider>`)
// to avoid a schema migration — same pattern as file-agent overrides.

export type PersistableQuotaProvider = 'claude' | 'codex';

function keyFor(provider: string): string {
  return `quota_snapshot:${provider}`;
}

// Track the last persisted `fetchedAt` per provider so cache-hit reads (which
// resolve the same snapshot repeatedly) don't spam the DB with identical
// upserts. Pinned to globalThis — Next.js duplicates modules across realms.
declare global {
  // eslint-disable-next-line no-var
  var __tamtamQuotaPersistedAt: Map<string, number> | undefined;
}
const _persistedAt: Map<string, number> = globalThis.__tamtamQuotaPersistedAt ?? new Map();
globalThis.__tamtamQuotaPersistedAt = _persistedAt;

function isPersistable(
  snapshot: QuotaSnapshot | null | undefined,
): snapshot is QuotaSnapshot & { provider: PersistableQuotaProvider } {
  return (
    !!snapshot
    && (snapshot.provider === 'claude' || snapshot.provider === 'codex')
    // Only persist a real snapshot — never an empty/error shape.
    && (!!snapshot.fiveHour || !!snapshot.sevenDay)
  );
}

/**
 * Best-effort upsert of a fresh snapshot (fire-and-forget). Skips redundant
 * writes when the snapshot's `fetchedAt` hasn't advanced since the last persist.
 */
export function persistQuotaSnapshot(snapshot: QuotaSnapshot | null | undefined): void {
  if (!isPersistable(snapshot)) return;
  const provider = snapshot.provider;
  const fetchedAt = typeof snapshot.fetchedAt === 'number' ? snapshot.fetchedAt : 0;
  if (fetchedAt !== 0 && _persistedAt.get(provider) === fetchedAt) return;
  _persistedAt.set(provider, fetchedAt);
  void (async () => {
    try {
      const { db, schema } = await import('@/lib/db');
      const value = JSON.stringify(snapshot);
      await db
        .insert(schema.settings)
        .values({ key: keyFor(provider), value })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
        .execute();
    } catch (err) {
      // Reset the throttle marker so a later call can retry the write.
      _persistedAt.delete(provider);
      console.error(`[quota-store] persist ${provider} failed:`, err);
    }
  })();
}

/**
 * Read the last persisted snapshot for a provider, or null. The caller is
 * responsible for marking it `stale: true` before serving it as a fallback.
 */
export async function readPersistedQuotaSnapshot(
  provider: PersistableQuotaProvider,
): Promise<QuotaSnapshot | null> {
  try {
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, keyFor(provider)))
      .limit(1);
    const row = rows[0] ?? null;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as QuotaSnapshot;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
