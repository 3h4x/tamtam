/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { JobsPauseToggle } from '@/components/JobsPauseToggle'

const { fmtAbsoluteMock } = vi.hoisted(() => ({
  fmtAbsoluteMock: vi.fn(() => 'May 10, 2026, 12:00'),
}))

vi.mock('@/lib/shared/format-date', () => ({
  fmtAbsolute: fmtAbsoluteMock,
}))

function makeResponse(body: unknown, ok = true) {
  return {
    ok,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
  }
}

function renderToggle() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(JobsPauseToggle))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function getButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button')
  if (!(button instanceof HTMLButtonElement)) throw new Error('toggle button not found')
  return button
}

describe('JobsPauseToggle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'))
    fmtAbsoluteMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('shows the manual paused state when jobs_paused is enabled', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/settings') return makeResponse({ settings: { jobs_paused: 'true' } })
      if (input === '/api/usage/quota') {
        return makeResponse({
          gateEnabled: true,
          sevenDay: {
            utilization: 90,
            resetsAt: '2026-05-10T12:00:00.000Z',
            msUntilReset: 24 * 60 * 60 * 1000,
          },
        })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderToggle()

    await vi.waitFor(() => {
      const button = getButton(container)
      expect(button.textContent).toBe('jobs paused')
      expect(button.getAttribute('aria-checked')).toBe('true')
      expect(button.title).toBe('Jobs paused — click to resume')
    })

    expect(fmtAbsoluteMock).not.toHaveBeenCalled()
    unmount()
  })

  it('shows scheduled paused only when the budget gate is enabled', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/settings') return makeResponse({ settings: { jobs_paused: 'false' } })
      if (input === '/api/usage/quota') {
        return makeResponse({
          gateEnabled: true,
          sevenDay: {
            utilization: 90,
            resetsAt: '2026-05-10T12:00:00.000Z',
            msUntilReset: 24 * 60 * 60 * 1000,
          },
        })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderToggle()

    await vi.waitFor(() => {
      const button = getButton(container)
      expect(button.textContent).toBe('scheduled paused')
      expect(button.getAttribute('aria-checked')).toBe('false')
      expect(button.title).toContain('Scheduled agents paused by weekly budget')
      expect(button.title).toContain('May 10, 2026, 12:00')
    })

    expect(fmtAbsoluteMock).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('falls back to jobs running when the quota gate is disabled and rolls back on save failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/settings' && !init) {
        return makeResponse({ settings: { jobs_paused: 'false' } })
      }
      if (input === '/api/usage/quota') {
        return makeResponse({
          gateEnabled: false,
          sevenDay: {
            utilization: 90,
            resetsAt: '2026-05-10T12:00:00.000Z',
            msUntilReset: 24 * 60 * 60 * 1000,
          },
        })
      }
      if (input === '/api/settings' && init?.method === 'PATCH') {
        return makeResponse({ detail: 'write failed' }, false)
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderToggle()

    await vi.waitFor(() => {
      const button = getButton(container)
      expect(button.textContent).toBe('jobs running')
      expect(button.title).toBe('Pause jobs')
      expect(button.disabled).toBe(false)
    })

    getButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([input, init]) => input === '/api/settings' && (init as RequestInit | undefined)?.method === 'PATCH',
      )).toBe(true)
    })

    await vi.waitFor(() => {
      const button = getButton(container)
      expect(button.textContent).toBe('jobs running')
      expect(button.getAttribute('aria-checked')).toBe('false')
    })

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('[jobs-pause-toggle]', 'write failed')
    })
    expect(fmtAbsoluteMock).not.toHaveBeenCalled()
    unmount()
  })
})
