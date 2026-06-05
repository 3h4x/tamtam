/* @vitest-environment jsdom */

import React from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { usePolling } from '@/hooks/usePolling'

type PollOptions = Parameters<typeof usePolling>[1]

// Mount the hook through react-dom/client directly rather than
// @testing-library/react's renderHook: renderHook routes through
// react-dom/test-utils `act`, which references `React.act` — stripped from the
// production React build the suite runs under, so it throws
// `React.act is not a function`. createRoot + flushSync mirrors the rest of the
// tsx tests in this repo.
function mountPolling(callback: () => void | Promise<void>, options: PollOptions) {
  function Harness() {
    usePolling(callback, options)
    return null
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(React.createElement(Harness))
  })

  return () => {
    flushSync(() => {
      root.unmount()
    })
    container.remove()
  }
}

describe('usePolling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not overlap requests: waits for the in-flight call to settle', async () => {
    let resolve: (() => void) | undefined
    const cb = vi.fn(() => new Promise<void>((r) => { resolve = r }))

    const unmount = mountPolling(cb, { intervalMs: 1000 })

    // Immediate first call.
    expect(cb).toHaveBeenCalledTimes(1)

    // Even past the interval, no second call while the first is unresolved.
    await vi.advanceTimersByTimeAsync(5000)
    expect(cb).toHaveBeenCalledTimes(1)

    // Once it settles, the next tick is scheduled after intervalMs.
    resolve?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(cb).toHaveBeenCalledTimes(2)

    unmount()
  })

  it('backs off exponentially on consecutive failures', async () => {
    const cb = vi.fn(() => Promise.reject(new Error('boom')))

    const unmount = mountPolling(cb, { intervalMs: 1000, maxBackoffMs: 60_000 })

    // First (immediate) call fails.
    await vi.advanceTimersByTimeAsync(0)
    expect(cb).toHaveBeenCalledTimes(1)

    // After 1 failure: delay = 1000 * 2^1 = 2000ms. Not yet at 1999.
    await vi.advanceTimersByTimeAsync(1999)
    expect(cb).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(cb).toHaveBeenCalledTimes(2)

    // After 2 failures: delay = 1000 * 2^2 = 4000ms.
    await vi.advanceTimersByTimeAsync(3999)
    expect(cb).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(cb).toHaveBeenCalledTimes(3)

    unmount()
  })

  it('does not poll when disabled', async () => {
    const cb = vi.fn(() => Promise.resolve())
    const unmount = mountPolling(cb, { intervalMs: 1000, enabled: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(cb).not.toHaveBeenCalled()
    unmount()
  })
})
