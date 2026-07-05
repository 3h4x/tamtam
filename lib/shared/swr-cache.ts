// Single-flight stale-while-revalidate (SWR) cache primitive.
//
// Why SWR and not a plain TTL: the project-page header endpoints (branch,
// config, release-plan) each do seconds of git/fs/DB work. A plain short-TTL
// cache barely helps a real user, because humans revisit a project minutes
// apart — far beyond any short TTL — so every visit misses and pays the full
// recompute. That is exactly the "slow to show every time" symptom. SWR fixes
// it: once a value exists, every subsequent read returns it *immediately* (even
// when stale) and kicks off a background refresh, so only the very first read
// per key is ever slow. Concurrent misses are single-flighted, so a refetch
// storm collapses to one compute.
//
// This module only provides the logic; call sites pin the store to globalThis
// (Next.js duplicates modules across bundle realms).

export interface SwrStore<T> {
  cache: Map<string, { value: T; time: number }>;
  inflight: Map<string, Promise<T>>;
}

/** Build an empty store (call sites usually pin the two maps to globalThis and
 *  pass them in as a store object literal instead). */
export function createSwrStore<T>(): SwrStore<T> {
  return { cache: new Map(), inflight: new Map() };
}

function revalidate<T>(store: SwrStore<T>, key: string, compute: () => Promise<T>): Promise<T> {
  let pending = store.inflight.get(key);
  if (!pending) {
    pending = compute()
      .then((value) => {
        store.cache.set(key, { value, time: Date.now() });
        return value;
      })
      .finally(() => {
        store.inflight.delete(key);
      });
    store.inflight.set(key, pending);
  }
  return pending;
}

/**
 * Read `key` with stale-while-revalidate semantics:
 * - fresh hit (age < ttlMs) → returned immediately, no work.
 * - stale hit (age >= ttlMs) → the stale value is returned immediately and a
 *   single-flight background refresh is started. Background-refresh errors are
 *   swallowed: we keep serving the last good value until a refresh succeeds.
 * - cold miss (no value yet) → awaits a single-flight compute (the only slow
 *   path, hit once per key).
 */
export function swrGet<T>(
  store: SwrStore<T>,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = store.cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) {
    return Promise.resolve(hit.value);
  }
  if (hit) {
    // Stale: serve now, revalidate in the background.
    void revalidate(store, key, compute).catch(() => {});
    return Promise.resolve(hit.value);
  }
  // Cold: must wait for the first compute.
  return revalidate(store, key, compute);
}

/**
 * Force a fresh compute, update the cache, and return it — bypassing both the
 * cached value and SWR staleness. Use after a mutation when the next read must
 * reflect the just-written state. A rejected compute is not cached.
 */
export async function swrRefresh<T>(
  store: SwrStore<T>,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const value = await compute();
  store.cache.set(key, { value, time: Date.now() });
  return value;
}

/** Drop a key's cached value (call after a write when you can't refresh inline). */
export function swrClear<T>(store: SwrStore<T>, key: string): void {
  store.cache.delete(key);
}
