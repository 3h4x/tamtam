/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { InfraTab } from '@/components/monitoring/InfraTab'
import type { MonitoringData } from '@/components/monitoring/types'

function buildMonitoringData(overrides: Partial<MonitoringData> = {}): MonitoringData {
  return {
    prometheus: {
      status: 'ok',
      alerts: [],
      services: [],
    },
    loki: {
      status: 'ok',
      errors: [],
      warnings: [],
    },
    notificationThrottle: {
      windowSeconds: 900,
      overrides: {},
      suppressedTotal: 0,
      entries: [],
    },
    retention: {
      policy: {
        logRetentionCount: 200,
        logRetentionDays: 30,
        jobRowRetentionDays: 180,
      },
      lastNightlyCleanup: null,
      lastProjectLogCleanup: null,
    },
    hasIssues: false,
    fetchedAt: 1_716_200_000_000,
    windowMs: 15 * 60 * 1000,
    config: {
      prometheusUrl: 'http://prometheus.internal:9090',
      lokiUrl: 'http://loki.internal:3100',
    },
    ...overrides,
  }
}

function renderInfraTab(data: MonitoringData) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<InfraTab data={data} window_="15m" />)
  })

  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

describe('InfraTab', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows the configured endpoints when Prometheus and Loki are unavailable', () => {
    const { container, unmount } = renderInfraTab(buildMonitoringData({
      prometheus: { status: 'unavailable', alerts: [], services: [] },
      loki: { status: 'unavailable', errors: [], warnings: [] },
    }))

    expect(container.textContent).toContain('Not reachable at')
    expect(container.textContent).toContain('http://prometheus.internal:9090')
    expect(container.textContent).toContain('http://loki.internal:3100')

    unmount()
  })

  it('extracts JSON log messages and toggles long log lines open and closed', () => {
    const uniqueTail = 'UNIQUE LOG TAIL SHOULD ONLY APPEAR WHEN EXPANDED'
    const longMessage = `${'deploy step failed '.repeat(8)}${uniqueTail}`
    const { container, unmount } = renderInfraTab(buildMonitoringData({
      prometheus: {
        status: 'ok',
        alerts: [],
        services: [{ metric: { job: 'api', instance: 'api-1' }, value: [1, '1'] }],
      },
      loki: {
        status: 'ok',
        errors: [
          {
            ts: '1716200000000000000',
            stream: { job: 'release-worker' },
            line: JSON.stringify({ msg: longMessage, ignored: 'payload' }),
          },
        ],
        warnings: [],
      },
    }))

    expect(container.textContent).toContain('[release-worker]')
    expect(container.textContent).toContain(longMessage.slice(0, 140))
    expect(container.textContent).not.toContain(uniqueTail)
    expect(container.textContent).not.toContain('{"msg":')

    const row = container.querySelector('[title="Click to expand"]')
    if (!(row instanceof HTMLDivElement)) throw new Error('expandable log row not found')

    flushSync(() => {
      row.click()
    })

    expect(container.textContent).toContain(uniqueTail)
    expect(container.textContent).toContain('collapse')

    const collapse = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent?.includes('collapse'),
    )
    if (!(collapse instanceof HTMLButtonElement)) throw new Error('collapse button not found')

    flushSync(() => {
      collapse.click()
    })

    expect(container.textContent).not.toContain(uniqueTail)

    unmount()
  })
})
