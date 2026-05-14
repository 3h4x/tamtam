/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { OverviewTab } from '@/components/monitoring/OverviewTab'
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
      lastNightlyCleanup: {
        type: 'nightly',
        status: 'completed',
        startedAt: 1_700_000_000,
        finishedAt: 1_700_000_010,
        rowsScanned: 4,
        rowsDeleted: 3,
        skippedRunningRows: 0,
        errorCount: 0,
        lastError: null,
      },
      lastProjectLogCleanup: {
        type: 'project_logs',
        project: 'proj',
        status: 'completed',
        startedAt: 1_700_000_020,
        finishedAt: 1_700_000_030,
        rowsScanned: 4,
        rowsEligible: 1,
        rowsUpdated: 1,
        logFilesDeleted: 1,
        bytesReclaimed: 2048,
        skippedRunningRows: 0,
        errorCount: 0,
        lastError: null,
      },
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

function renderOverview(data: MonitoringData, pm2Logs: Pm2LogData | null = null) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<OverviewTab data={data} pm2Logs={pm2Logs} window_="15m" />)
  })

  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

describe('Monitoring OverviewTab', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('surfaces PM2 errors and warnings in the tamtam card', () => {
    const data = buildMonitoringData()
    const pm2Logs: Pm2LogData = {
      files: [],
      fetchedAt: 1_700_000_100,
      entries: [
        { ts: '2026-05-13T10:00:00.000Z', level: 'error', line: 'runner crashed', source: 'error' },
        { ts: '2026-05-13T10:01:00.000Z', level: 'warn', line: 'queue lagging', source: 'out' },
      ],
    }

    const { container, unmount } = renderOverview(data, pm2Logs)

    const cards = Array.from(container.querySelectorAll('div.rounded-lg.border'))
    const pm2Card = cards.find((card) => card.textContent?.includes('tamtam (PM2)'))
    expect(pm2Card?.className).toContain('text-status-warning')
    expect(pm2Card?.textContent).toContain('1 error')
    expect(pm2Card?.textContent).toContain('1 warning')

    unmount()
  })

  it('marks retention as unavailable when no cleanup summaries have been recorded yet', () => {
    const data = buildMonitoringData({
      retention: {
        policy: {
          logRetentionCount: 200,
          logRetentionDays: 30,
          jobRowRetentionDays: 180,
        },
        lastNightlyCleanup: null,
        lastProjectLogCleanup: null,
      },
    })

    const { container, unmount } = renderOverview(data)

    const cards = Array.from(container.querySelectorAll('div.rounded-lg.border'))
    const retentionCard = cards.find((card) => card.textContent?.includes('Retention'))
    expect(retentionCard?.className).toContain('text-text-tertiary')
    expect(retentionCard?.textContent).toContain('No nightly cleanup recorded')
    expect(retentionCard?.textContent).toContain('No project log prune recorded')

    unmount()
  })

  it('marks retention as an issue when nightly cleanup reports a failure', () => {
    const data = buildMonitoringData({
      retention: {
        policy: {
          logRetentionCount: 200,
          logRetentionDays: 30,
          jobRowRetentionDays: 180,
        },
        lastNightlyCleanup: {
          type: 'nightly',
          status: 'failed',
          startedAt: 1_700_000_000,
          finishedAt: 1_700_000_010,
          rowsScanned: 4,
          rowsDeleted: 0,
          skippedRunningRows: 0,
          errorCount: 1,
          lastError: 'connection refused',
        },
        lastProjectLogCleanup: {
          type: 'project_logs',
          project: 'proj',
          status: 'completed',
          startedAt: 1_700_000_020,
          finishedAt: 1_700_000_030,
          rowsScanned: 4,
          rowsEligible: 1,
          rowsUpdated: 1,
          logFilesDeleted: 1,
          bytesReclaimed: 2048,
          skippedRunningRows: 0,
          errorCount: 0,
          lastError: null,
        },
      },
    })

    const { container, unmount } = renderOverview(data)

    const cards = Array.from(container.querySelectorAll('div.rounded-lg.border'))
    const retentionCard = cards.find((card) => card.textContent?.includes('Retention'))
    expect(retentionCard?.className).toContain('text-status-warning')
    expect(retentionCard?.textContent).toContain('failed')
    expect(retentionCard?.textContent).toContain('connection refused')

    unmount()
  })

  it('marks retention as an issue when project log cleanup failed even if nightly cleanup succeeded', () => {
    const data = buildMonitoringData({
      retention: {
        policy: {
          logRetentionCount: 200,
          logRetentionDays: 30,
          jobRowRetentionDays: 180,
        },
        lastNightlyCleanup: {
          type: 'nightly',
          status: 'completed',
          startedAt: 1_700_000_000,
          finishedAt: 1_700_000_010,
          rowsScanned: 4,
          rowsDeleted: 3,
          skippedRunningRows: 0,
          errorCount: 0,
          lastError: null,
        },
        lastProjectLogCleanup: {
          type: 'project_logs',
          project: 'proj',
          status: 'failed',
          startedAt: 1_700_000_020,
          finishedAt: 1_700_000_030,
          rowsScanned: 4,
          rowsEligible: 2,
          rowsUpdated: 1,
          logFilesDeleted: 0,
          bytesReclaimed: 0,
          skippedRunningRows: 0,
          errorCount: 1,
          lastError: 'EPERM unlink denied',
        },
      },
    })

    const { container, unmount } = renderOverview(data)

    expect(container.textContent).toContain('Retention')
    expect(container.textContent).toContain('failed')
    expect(container.textContent).toContain('EPERM unlink denied')
    expect(container.textContent).toContain('completed')

    const cards = Array.from(container.querySelectorAll('div.rounded-lg.border'))
    const retentionCard = cards.find((card) => card.textContent?.includes('Retention'))
    expect(retentionCard?.className).toContain('text-status-warning')
    expect(retentionCard?.textContent).toContain('failed · 0 files, 0 B · EPERM unlink denied')

    unmount()
  })

  it('renders notification throttle entries and suppressed summary when alerts are queued', () => {
    const data = buildMonitoringData({
      notificationThrottle: {
        windowSeconds: 900,
        overrides: {},
        suppressedTotal: 3,
        entries: [
          {
            key: 'review_do_not_ship:proj:review',
            lastSentAt: Date.UTC(2026, 4, 13, 10, 0, 0),
            suppressedCount: 2,
          },
          {
            key: 'agent_run_fail:proj:qa',
            lastSentAt: Date.UTC(2026, 4, 13, 11, 0, 0),
            suppressedCount: 1,
          },
        ],
      },
    })

    const { container, unmount } = renderOverview(data)

    expect(container.textContent).toContain('3 suppressed alerts pending')
    expect(container.textContent).toContain('Notification throttle')
    expect(container.textContent).toContain('review_do_not_ship:proj:review')
    expect(container.textContent).toContain('2 suppressed')
    expect(container.textContent).toContain('agent_run_fail:proj:qa')

    unmount()
  })
})
