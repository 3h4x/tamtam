'use client'

import { useEffect, useState } from 'react'

/**
 * Returns false on first render, then flips to true once the initial mount
 * request burst has cleared — after which it is safe to mount non-critical,
 * network-heavy panels.
 *
 * Use it to defer the MOUNT (and therefore the data fetch) of below-the-fold
 * panels so their requests don't compete with the above-the-fold header requests
 * for the browser's ~6-connections-per-host limit and the server's single
 * event-loop thread on page load. The project page fires ~14 requests on mount;
 * deferring the below-the-fold stats panels (the heaviest — agent stats,
 * pipeline stats, prompt insights) lets the header's requests claim sockets and
 * event-loop time first, so the header's status fills in sooner.
 *
 * We deliberately DON'T use a bare `requestIdleCallback`: the browser reports its
 * first idle gap almost immediately after the initial paint (~130 ms — measured),
 * i.e. right in the MIDDLE of the mount stampede, so the "deferred" panels fired
 * their fetches alongside the header's and defeated the whole point. Instead we
 * hold for a fixed `minDelayMs` (past the burst's peak-contention window) and
 * THEN mount on the next idle callback, so the panels still yield to any
 * in-flight render but no longer join the stampede. The panels always mount
 * (never gated on scroll/data), so server-rendered/e2e assertions still find
 * them — just a beat later, well within their wait timeouts.
 */
export function useDeferredMount(minDelayMs = 800): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    let idleId: number | undefined
    const timer = window.setTimeout(() => {
      if (typeof w.requestIdleCallback === 'function') {
        idleId = w.requestIdleCallback(() => setReady(true), { timeout: 200 })
      } else {
        setReady(true)
      }
    }, minDelayMs)
    return () => {
      window.clearTimeout(timer)
      if (idleId != null) w.cancelIdleCallback?.(idleId)
    }
  }, [minDelayMs])
  return ready
}
