// Client-side GET dedup + short-TTL cache.
//
// TamTam's project tabs fully remount on every tab switch (there is no shared
// `app/project/[name]/layout.tsx`), so without this each switch refetches the
// entire project shell (config, branch, behind, issues summary, custom
// actions) even though it was just fetched, and several components fetch the
// same endpoint concurrently on one render. Browser-measured: one Overview→
// Changes switch fired 19 requests, 0 served from cache.
//
// This collapses concurrent identical GETs into a single in-flight request
// (dedup) and reuses a fresh response for a short TTL so a rapid tab switch
// reuses data instead of re-hitting the network. It is deliberately tiny and
// module-scoped (per-tab session). Mutations MUST call `invalidateGet()` (or
// callers pass `{ force: true }`) so a write is never followed by a stale read.

interface CacheEntry {
  at: number
  value: unknown
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<unknown>>()

export class CachedGetError extends Error {
  status: number
  statusText: string
  constructor(status: number, statusText: string) {
    super(`request failed: ${status} ${statusText}`)
    this.name = 'CachedGetError'
    this.status = status
    this.statusText = statusText
  }
}

/**
 * Fetch `url` as JSON with in-flight dedup and an optional short TTL memo.
 * - Concurrent calls for the same `url` share one network request.
 * - Within `ttlMs` of a successful fetch, the cached value is returned without
 *   a network hit. `ttlMs: 0` (default) = dedup only, never memo.
 * - `force: true` bypasses the memo (still dedups + refreshes the memo) — use
 *   it for the reload after a mutation.
 * Non-2xx responses reject with `CachedGetError` and are never cached.
 */
export async function cachedGet<T>(
  url: string,
  opts: { ttlMs?: number; force?: boolean; init?: RequestInit } = {},
): Promise<T> {
  const ttl = opts.ttlMs ?? 0
  if (ttl > 0 && !opts.force) {
    const hit = cache.get(url)
    if (hit && Date.now() - hit.at < ttl) return hit.value as T
  }
  const existing = inflight.get(url)
  if (existing) return existing as Promise<T>

  const p = fetch(url, opts.init)
    .then(async (r) => {
      if (!r.ok) throw new CachedGetError(r.status, r.statusText)
      const value = (await r.json()) as T
      if (ttl > 0) cache.set(url, { at: Date.now(), value })
      return value
    })
    .finally(() => {
      inflight.delete(url)
    })
  inflight.set(url, p)
  return p as Promise<T>
}

/** Drop every cached/in-flight entry whose URL contains `substr`. Call after a
 *  mutation so the next read re-fetches (e.g. after PATCH /config, invalidate
 *  the `/config` entry for that project). */
export function invalidateGet(substr: string): void {
  for (const k of [...cache.keys()]) if (k.includes(substr)) cache.delete(k)
  for (const k of [...inflight.keys()]) if (k.includes(substr)) inflight.delete(k)
}
