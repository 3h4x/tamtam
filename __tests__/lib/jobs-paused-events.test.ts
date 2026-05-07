/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import {
  dispatchJobsPausedChanged,
  JOBS_PAUSED_CHANGED_EVENT,
  subscribeToJobsPausedChanged,
} from '@/lib/shared/jobs-paused-events'

describe('jobs-paused-events', () => {
  it('dispatches the shared pause-state event with the expected detail', () => {
    const listener = vi.fn()
    window.addEventListener(JOBS_PAUSED_CHANGED_EVENT, listener)

    dispatchJobsPausedChanged(true)

    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock.calls[0]?.[0]
    expect(event).toBeInstanceOf(CustomEvent)
    expect((event as CustomEvent<{ paused: boolean }>).detail).toEqual({ paused: true })

    window.removeEventListener(JOBS_PAUSED_CHANGED_EVENT, listener)
  })

  it('subscribes, normalizes the paused flag, and unsubscribes cleanly', () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeToJobsPausedChanged(onChange)

    dispatchJobsPausedChanged(true)
    window.dispatchEvent(new CustomEvent(JOBS_PAUSED_CHANGED_EVENT, {
      detail: { paused: false },
    }))
    window.dispatchEvent(new CustomEvent(JOBS_PAUSED_CHANGED_EVENT))

    expect(onChange.mock.calls).toEqual([[true], [false], [false]])

    unsubscribe()
    dispatchJobsPausedChanged(true)
    expect(onChange).toHaveBeenCalledTimes(3)
  })
})
