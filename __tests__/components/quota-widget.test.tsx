/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { QuotaWidget } from '@/components/QuotaWidget'

interface MockSnapshot {
  provider: 'claude' | 'codex'
  fiveHourPct?: number
  sevenDayPct?: number
  msUntilReset?: number
  gateEnabled?: boolean
  sevenDaySonnet?: boolean
}

function makeSnapshot({
  provider,
  fiveHourPct = 10,
  sevenDayPct = 10,
  msUntilReset = 24 * 60 * 60 * 1000,
  gateEnabled = true,
  sevenDaySonnet = false,
}: MockSnapshot) {
  return {
    provider,
    fiveHour: {
      utilization: fiveHourPct,
      resetsAt: '2026-05-10T12:00:00.000Z',
      msUntilReset: 60 * 60 * 1000,
    },
    sevenDay: {
      utilization: sevenDayPct,
      resetsAt: '2026-05-10T12:00:00.000Z',
      msUntilReset,
    },
    sevenDaySonnet: sevenDaySonnet
      ? {
          utilization: sevenDayPct,
          resetsAt: '2026-05-10T12:00:00.000Z',
          msUntilReset,
        }
      : null,
    fetchedAt: Date.now(),
    stale: false,
    gateEnabled,
  }
}

function makeResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  }
}

function renderQuotaWidget(props: React.ComponentProps<typeof QuotaWidget>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(QuotaWidget, props))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function findCard(container: HTMLElement, title: string): HTMLElement {
  const heading = Array.from(container.querySelectorAll('div')).find((node) => node.textContent === title)
  if (!heading) throw new Error(`Could not find card titled "${title}"`)
  const card = heading.closest('.rounded-lg')
  if (!(card instanceof HTMLElement)) throw new Error(`Could not resolve card for "${title}"`)
  return card
}

describe('QuotaWidget', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders the active provider card as primary even when it is not first in the selected list', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/usage/quota') {
        return makeResponse(makeSnapshot({
          provider: 'codex',
          sevenDayPct: 90,
          sevenDaySonnet: true,
        }))
      }
      if (input === '/api/usage/quota?provider=claude') {
        return makeResponse(makeSnapshot({ provider: 'claude', sevenDayPct: 10 }))
      }
      if (input === '/api/usage/quota?provider=codex') {
        return makeResponse(makeSnapshot({ provider: 'codex', sevenDayPct: 20 }))
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderQuotaWidget({
      providers: ['claude', 'codex'],
      refreshSeconds: 999,
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Codex subscription quota')
      expect(container.textContent).toContain('Claude subscription quota')
    })

    const codexCard = findCard(container, 'Codex subscription quota')
    const claudeCard = findCard(container, 'Claude subscription quota')

    expect(codexCard.textContent).toContain('Scheduled agents')
    expect(codexCard.textContent).toContain('7d · Sonnet')
    expect(claudeCard.textContent).not.toContain('Scheduled agents')
    expect(claudeCard.textContent).not.toContain('7d · Sonnet')

    unmount()
  })

  it('keeps the first successful card primary when an earlier provider fetch fails', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/usage/quota') {
        return makeResponse({ error: 'active quota unavailable' }, false)
      }
      if (input === '/api/usage/quota?provider=claude') {
        return makeResponse({ error: 'claude quota unavailable' }, false)
      }
      if (input === '/api/usage/quota?provider=codex') {
        return makeResponse(makeSnapshot({
          provider: 'codex',
          sevenDayPct: 90,
          sevenDaySonnet: true,
        }))
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderQuotaWidget({
      providers: ['claude', 'codex'],
      refreshSeconds: 999,
    })

    await vi.waitFor(() => {
      const codexCard = findCard(container, 'Codex subscription quota')
      expect(codexCard.textContent).toContain('Scheduled agents')
    })

    const codexCard = findCard(container, 'Codex subscription quota')
    const claudeCard = findCard(container, 'Claude subscription quota')

    expect(codexCard.textContent).toContain('Scheduled agents')
    expect(codexCard.textContent).toContain('7d · Sonnet')
    expect(claudeCard.textContent).toContain('quota unavailable')
    expect(claudeCard.textContent).not.toContain('Scheduled agents')

    unmount()
  })

  it('renders typed unavailable quota responses without throwing away successful providers', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/usage/quota') {
        return makeResponse({
          available: false,
          reason: 'rate_limited',
          error: 'Claude quota temporarily unavailable',
        })
      }
      if (input === '/api/usage/quota?provider=claude') {
        return makeResponse({
          available: false,
          reason: 'not_configured',
          error: 'No Claude OAuth token found',
        })
      }
      if (input === '/api/usage/quota?provider=codex') {
        return makeResponse(makeSnapshot({ provider: 'codex', sevenDayPct: 30 }))
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderQuotaWidget({
      providers: ['claude', 'codex'],
      refreshSeconds: 999,
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Codex subscription quota')
    })

    const codexCard = findCard(container, 'Codex subscription quota')
    const claudeCard = findCard(container, 'Claude subscription quota')

    expect(codexCard.textContent).toContain('7-day weekly')
    expect(claudeCard.textContent).toContain('No Claude OAuth token found')

    unmount()
  })
})
