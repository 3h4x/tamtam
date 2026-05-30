/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MonitoringPage } from '@/components/MonitoringPage'
import type { MonitoringData } from '@/components/monitoring/types'
import type { Pm2LogData } from '@/components/monitoring/Pm2LogPanel'

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
    fetchedAt: 1_700_000_100,
    windowMs: 15 * 60 * 1000,
    config: {
      prometheusUrl: 'http://localhost:9090',
      lokiUrl: 'http://localhost:3100',
    },
    ...overrides,
  }
}

function buildPm2Logs(): Pm2LogData {
  return {
    files: [],
    entries: [],
    fetchedAt: 1_700_000_100,
  }
}

function buildReadiness() {
  return {
    status: 'ok',
    ok: true,
    checks: [],
  }
}

function responseJson(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response
}

describe('MonitoringPage', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  async function settleReact() {
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => {})
  }

  async function waitFor(assertion: () => void) {
    let lastError: unknown
    for (let i = 0; i < 10; i += 1) {
      try {
        assertion()
        return
      } catch (err) {
        lastError = err
        await settleReact()
      }
    }
    throw lastError
  }

  async function renderWithData(data: MonitoringData) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('/api/monitoring/pm2-logs')) return responseJson(buildPm2Logs())
      if (url.startsWith('/api/monitoring?')) return responseJson(data)
      if (url.startsWith('/api/health')) return responseJson(buildReadiness())
      return responseJson({})
    })

    flushSync(() => {
      root.render(<MonitoringPage />)
    })

    await waitFor(() => {
      expect(container.textContent).toContain('Refresh')
    })
  }

  it.each([
    { label: 'success', data: buildMonitoringData({ hasIssues: false }), summaryClass: 'text-status-success' },
    { label: 'warning', data: buildMonitoringData({ hasIssues: true }), summaryClass: 'text-status-warning' },
  ])('keeps the refresh button on the $label summary status color', async ({ data, summaryClass }) => {
    await renderWithData(data)

    const refresh = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Refresh',
    )
    if (!(refresh instanceof HTMLButtonElement)) throw new Error('Refresh button not found')

    const summary = refresh.closest('div.rounded-lg.border')
    expect(summary?.className).toContain(summaryClass)
    expect(refresh.className).toContain('!text-current')
  })
})
