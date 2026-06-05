import { useEffect, useRef } from 'react'

interface UsePollingOptions {
  /** Base delay between successful polls, in ms. */
  intervalMs: number
  /** When false, polling is suspended (and any pending tick cancelled). Default true. */
  enabled?: boolean
  /** Upper bound for the exponential backoff applied after consecutive failures. Default 60s. */
  maxBackoffMs?: number
  /** Run the callback immediately on mount before the first interval. Default true. */
  immediate?: boolean
}

/**
 * Recurring poll that — unlike `setInterval` — never overlaps requests and
 * backs off when they fail.
 *
 * `setInterval(fn, 5000)` fires every 5s regardless of whether the previous
 * request finished. When the backend hangs (e.g. a Postgres restart wedges the
 * connection pool), each request stays in-flight for its full timeout while new
 * ones keep launching, piling up into a thundering herd with no backoff. This
 * hook schedules the next tick only after the current one settles, and doubles
 * the delay (up to `maxBackoffMs`) for each consecutive failure, resetting to
 * `intervalMs` on the next success.
 *
 * The callback should THROW (or reject) to signal failure so backoff engages;
 * the thrown error is swallowed here and never surfaces to the component.
 */
export function usePolling(callback: () => void | Promise<void>, options: UsePollingOptions): void {
  const { intervalMs, enabled = true, maxBackoffMs = 60_000, immediate = true } = options
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    if (!enabled) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0

    const tick = async () => {
      try {
        await callbackRef.current()
        failures = 0
      } catch {
        failures += 1
      } finally {
        if (live) {
          const delay = Math.min(intervalMs * 2 ** failures, maxBackoffMs)
          timer = setTimeout(tick, delay)
        }
      }
    }

    if (immediate) {
      void tick()
    } else {
      timer = setTimeout(tick, intervalMs)
    }

    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [enabled, intervalMs, maxBackoffMs, immediate])
}
