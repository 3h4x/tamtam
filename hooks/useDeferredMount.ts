'use client'

import { useEffect, useState } from 'react'

/**
 * Returns false on first render, then flips to true once the browser is idle —
 * i.e. after the initial paint and the mount request burst have settled.
 *
 * Use it to defer the MOUNT (and therefore the data fetch) of non-critical,
 * network-heavy panels so their requests don't compete with the above-the-fold
 * header requests for the browser's ~6-connections-per-host limit and the
 * server's single event-loop thread on page load. The project page fires ~19
 * requests on mount; deferring the below-the-fold stats panels lets the header's
 * requests claim sockets and event-loop time first.
 *
 * `requestIdleCallback` fires when the browser has spare time (after the header
 * burst), with a `timeout` fallback so the panels still appear promptly on
 * browsers without it (Safari) or under sustained load.
 */
export function useDeferredMount(timeoutMs = 300): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: timeoutMs })
      return () => w.cancelIdleCallback?.(id)
    }
    const id = window.setTimeout(() => setReady(true), timeoutMs)
    return () => window.clearTimeout(id)
  }, [timeoutMs])
  return ready
}
