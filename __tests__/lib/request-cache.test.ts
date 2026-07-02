import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cachedGet, invalidateGet, CachedGetError } from '@/lib/client/request-cache'

function jsonResponse(value: unknown, ok = true, status = 200) {
  return { ok, status, statusText: ok ? 'OK' : 'ERR', json: async () => value } as Response
}

describe('cachedGet', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // Fresh module cache per test isn't trivial (module-scoped Map); use unique
    // URLs per test instead so entries don't collide.
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('dedupes concurrent identical GETs into one network request', async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r }))
    const url = '/api/dedupe-a'
    const p1 = cachedGet(url)
    const p2 = cachedGet(url)
    const p3 = cachedGet(url)
    resolve(jsonResponse({ n: 1 }))
    const [a, b, c] = await Promise.all([p1, p2, p3])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual({ n: 1 }); expect(b).toEqual({ n: 1 }); expect(c).toEqual({ n: 1 })
  })

  it('serves a fresh value from the TTL memo without a second fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ v: 'x' }))
    const url = '/api/ttl-a'
    await cachedGet(url, { ttlMs: 10_000 })
    await cachedGet(url, { ttlMs: 10_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ttlMs:0 (default) dedups only — sequential calls refetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ v: 'y' }))
    const url = '/api/nottl-a'
    await cachedGet(url)
    await cachedGet(url)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('force:true bypasses the memo and refetches', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ v: 'z' }))
    const url = '/api/force-a'
    await cachedGet(url, { ttlMs: 10_000 })
    await cachedGet(url, { ttlMs: 10_000, force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidateGet drops matching memo entries so the next read refetches', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ v: 'q' }))
    const url = '/api/inval-a/config'
    await cachedGet(url, { ttlMs: 10_000 })
    invalidateGet('/inval-a/config')
    await cachedGet(url, { ttlMs: 10_000 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects non-2xx with CachedGetError and does not cache it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500))
    const url = '/api/err-a'
    await expect(cachedGet(url, { ttlMs: 10_000 })).rejects.toBeInstanceOf(CachedGetError)
    fetchMock.mockResolvedValue(jsonResponse({ ok: 1 }))
    const v = await cachedGet(url, { ttlMs: 10_000 })
    expect(v).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
