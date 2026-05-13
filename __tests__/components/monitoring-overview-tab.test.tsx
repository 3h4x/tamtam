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
        sqliteMaintenance: {
          status: 'completed',
          startedAt: 1_700_000_000,
          finishedAt: 1_700_000_010,
          activeJobs: 0,
          checkpointRan: true,
          vacuumRan: true,
        },
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
          sqliteMaintenance: {
            status: 'completed',
            startedAt: 1_700_000_000,
            finishedAt: 1_700_000_010,
            activeJobs: 0,
            checkpointRan: true,
            vacuumRan: true,
          },
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
})
