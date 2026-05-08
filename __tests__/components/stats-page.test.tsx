/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { StatsPage } from '@/components/StatsPage'
import type { UsageResponse } from '@/app/api/stats/usage/route'

const { quotaWidgetMock } = vi.hoisted(() => ({
  quotaWidgetMock: vi.fn(
    ({ providers, warnAt, blockAt }: { providers: string[]; warnAt: number; blockAt: number }) => (
      <div
        data-testid="quota-widget"
        data-providers={providers.join(',')}
        data-warn-at={String(warnAt)}
        data-block-at={String(blockAt)}
      />
    ),
  ),
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
    ...props
  }: React.PropsWithChildren<{ href: string; className?: string }>) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@/components/QuotaWidget', () => ({
  QuotaWidget: quotaWidgetMock,
}))

function makeUsageResponse(overrides: Partial<UsageResponse> = {}): UsageResponse {
  return {
    window: '30d',
    generatedAt: new Date('2026-05-08T12:34:56Z').getTime(),
    pricing: {
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    },
    totals: {
      runs: 10,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreateTokens: 100,
      totalTokens: 1800,
      costUsd: 12.34,
    },
    projects: [
      {
        project: 'zeta',
        runs: 5,
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: 100,
        cacheCreateTokens: 50,
        totalTokens: 850,
        costUsd: 9.5,
        lastRunAt: Math.floor(new Date('2026-05-08T12:00:00Z').getTime() / 1000),
      },
      {
        project: 'alpha',
        runs: 2,
        inputTokens: 250,
        outputTokens: 100,
        cacheReadTokens: 50,
        cacheCreateTokens: 20,
        totalTokens: 420,
        costUsd: 1.2,
        lastRunAt: Math.floor(new Date('2026-05-08T10:00:00Z').getTime() / 1000),
      },
    ],
    agents: [
      {
        kind: 'commit',
        runs: 4,
        commitProducingRuns: 3,
        inputTokens: 400,
        outputTokens: 250,
        cacheReadTokens: 100,
        cacheCreateTokens: 50,
        totalTokens: 800,
        costUsd: 7.5,
        avgPromptBytes: 1200,
        avgPromptTokens: 300,
        promptSamples: 4,
      },
    ],
    ...overrides,
  }
}

function renderStatsPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(StatsPage))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function usageRows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('tbody tr'))
    .map((row) => row.textContent ?? '')
    .filter((text) => text.includes('alpha') || text.includes('zeta'))
}

function textButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === label,
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`)
  return button
}

function sortableHeader(container: HTMLElement, label: string): HTMLTableCellElement {
  const header = Array.from(container.querySelectorAll('th')).find((node) =>
    node.textContent?.includes(label),
  )
  if (!(header instanceof HTMLTableCellElement)) throw new Error(`header not found: ${label}`)
  return header
}

function makeResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  }
}

describe('StatsPage', () => {
  beforeEach(() => {
    quotaWidgetMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('loads usage data and applies budget settings to the quota widget', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/stats/usage?window=30d') return makeResponse(makeUsageResponse())
      if (input === '/api/settings') {
        return makeResponse({
          settings: {
            budget_warn_at_pct: '70',
            budget_block_at_pct: '85',
            budget_subscription_providers: 'codex',
          },
        })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderStatsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Statistics')
      expect(container.textContent).toContain('zeta')
    })

    const quotaWidget = container.querySelector('[data-testid="quota-widget"]')
    expect(quotaWidget?.getAttribute('data-providers')).toBe('codex')
    expect(quotaWidget?.getAttribute('data-warn-at')).toBe('70')
    expect(quotaWidget?.getAttribute('data-block-at')).toBe('85')
    expect(container.textContent).toContain('3 committed')

    unmount()
  })

  it('refetches when the window changes and re-sorts by project name on demand', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/stats/usage?window=30d') {
        return makeResponse(makeUsageResponse())
      }
      if (input === '/api/stats/usage?window=7d') {
        return makeResponse(makeUsageResponse({
          window: '7d',
          projects: [
            {
              project: 'zeta',
              runs: 1,
              inputTokens: 20,
              outputTokens: 10,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
              totalTokens: 30,
              costUsd: 0.9,
              lastRunAt: Math.floor(new Date('2026-05-08T11:00:00Z').getTime() / 1000),
            },
            {
              project: 'alpha',
              runs: 1,
              inputTokens: 20,
              outputTokens: 10,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
              totalTokens: 30,
              costUsd: 0.2,
              lastRunAt: Math.floor(new Date('2026-05-08T09:00:00Z').getTime() / 1000),
            },
          ],
        }))
      }
      if (input === '/api/settings') return makeResponse({ settings: {} })
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderStatsPage()

    await vi.waitFor(() => {
      expect(usageRows(container)[0]).toContain('zeta')
    })

    textButton(container, '7d').click()

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/stats/usage?window=7d')
    })

    await vi.waitFor(() => {
      expect(usageRows(container)[0]).toContain('zeta')
    })

    sortableHeader(container, 'Project').click()

    await vi.waitFor(() => {
      expect(usageRows(container)[0]).toContain('alpha')
      expect(usageRows(container)[1]).toContain('zeta')
    })

    unmount()
  })

  it('shows the error state and retries the stats request', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/settings') return makeResponse({ settings: {} })
      if (input === '/api/stats/usage?window=30d') {
        if (fetchMock.mock.calls.filter(([url]) => url === input).length === 1) {
          return makeResponse({ error: 'nope' }, false)
        }
        return makeResponse(makeUsageResponse({
          projects: [],
          agents: [],
        }))
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderStatsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to load usage stats')
    })

    textButton(container, 'Retry').click()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No usage data in the last 30 days.')
    })

    unmount()
  })
})
