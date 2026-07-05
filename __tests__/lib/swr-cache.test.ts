import { describe, it, expect, vi } from 'vitest';
import { createSwrStore, swrGet, swrRefresh, swrClear } from '@/lib/shared/swr-cache';

// A deferred so tests can control when a compute resolves.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('swr-cache', () => {
  it('awaits the compute on a cold miss and caches the result', async () => {
    const store = createSwrStore<number>();
    const compute = vi.fn().mockResolvedValue(42);
    expect(await swrGet(store, 'k', 1000, compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
    // Fresh hit — no recompute.
    expect(await swrGet(store, 'k', 1000, compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent cold misses into one compute', async () => {
    const store = createSwrStore<number>();
    const d = deferred<number>();
    const compute = vi.fn().mockReturnValue(d.promise);
    const p1 = swrGet(store, 'k', 1000, compute);
    const p2 = swrGet(store, 'k', 1000, compute);
    d.resolve(7);
    expect(await p1).toBe(7);
    expect(await p2).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('serves the stale value immediately and refreshes in the background', async () => {
    const store = createSwrStore<number>();
    // Seed a stale entry (time far in the past relative to a 10ms TTL).
    store.cache.set('k', { value: 1, time: 1 });
    const compute = vi.fn().mockResolvedValue(2);

    // Returns the STALE value now, without awaiting the recompute.
    expect(await swrGet(store, 'k', 10, compute)).toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);

    // Background refresh lands; the next read sees the fresh value.
    await flush();
    expect(store.cache.get('k')?.value).toBe(2);
    expect(await swrGet(store, 'k', 100000, compute)).toBe(2);
  });

  it('keeps serving the last good value when a background refresh fails', async () => {
    const store = createSwrStore<number>();
    store.cache.set('k', { value: 5, time: 1 });
    const compute = vi.fn().mockRejectedValue(new Error('boom'));

    // Stale value still returned; the rejected bg refresh must not throw here.
    expect(await swrGet(store, 'k', 10, compute)).toBe(5);
    await flush();
    // Value unchanged (last good), and a failed refresh was not cached.
    expect(store.cache.get('k')?.value).toBe(5);
  });

  it('swrRefresh forces a fresh compute and overwrites the cache', async () => {
    const store = createSwrStore<number>();
    store.cache.set('k', { value: 1, time: Date.now() }); // fresh entry
    const compute = vi.fn().mockResolvedValue(9);
    // Even though the entry is fresh, refresh bypasses it.
    expect(await swrRefresh(store, 'k', compute)).toBe(9);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(store.cache.get('k')?.value).toBe(9);
  });

  it('swrClear drops the cached value so the next read recomputes', async () => {
    const store = createSwrStore<number>();
    store.cache.set('k', { value: 1, time: Date.now() });
    swrClear(store, 'k');
    const compute = vi.fn().mockResolvedValue(3);
    expect(await swrGet(store, 'k', 1000, compute)).toBe(3);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
