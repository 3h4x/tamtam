/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Pm2LogPanel } from '@/components/monitoring/Pm2LogPanel'
import type { Pm2LogData } from '@/components/monitoring/Pm2LogPanel'

function buildPm2Logs(overrides: Partial<Pm2LogData> = {}): Pm2LogData {
  return {
    files: [
      { path: '/var/log/tamtam/out.log', size: 2048, mtime: '2026-05-20T10:00:00.000Z' },
      { path: '/var/log/tamtam/error.log', size: 1024, mtime: '2026-05-20T10:01:00.000Z' },
    ],
    entries: [
      { ts: '2026-05-20T10:00:00.000Z', level: 'error', line: 'runner crashed', source: 'error' },
      { ts: '2026-05-20T10:01:00.000Z', level: 'warn', line: 'queue lagging', source: 'out' },
      { ts: '2026-05-20T10:02:00.000Z', level: 'info', line: 'heartbeat ok', source: 'out' },
    ],
    fetchedAt: 1_716_200_000_000,
    ...overrides,
  }
}

function renderPanel(pm2Logs: Pm2LogData | null = buildPm2Logs()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<Pm2LogPanel pm2Logs={pm2Logs} onRefresh={vi.fn()} />)
  })

  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.includes(text),
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

describe('Pm2LogPanel', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('defaults to warn+ filtering and can reveal info lines on demand', () => {
    const { container, unmount } = renderPanel()

    expect(container.textContent).toContain('runner crashed')
    expect(container.textContent).toContain('queue lagging')
    expect(container.textContent).not.toContain('heartbeat ok')
    expect(container.textContent).toContain('showing 2 of 3')

    flushSync(() => {
      buttonByText(container, 'All').click()
    })

    expect(container.textContent).toContain('heartbeat ok')
    expect(container.textContent).not.toContain('showing 2 of 3')

    unmount()
  })

  it('can hide stdout sources and show the empty filtered state', () => {
    const { container, unmount } = renderPanel(buildPm2Logs({
      entries: [
        { ts: '2026-05-20T10:01:00.000Z', level: 'warn', line: 'queue lagging', source: 'out' },
        { ts: '2026-05-20T10:02:00.000Z', level: 'info', line: 'heartbeat ok', source: 'out' },
      ],
    }))

    expect(container.textContent).toContain('queue lagging')
    expect(container.textContent).toContain('all sources')

    flushSync(() => {
      buttonByText(container, 'all sources').click()
    })

    expect(container.textContent).toContain('errors only')
    expect(container.textContent).toContain('No recent PM2 log lines in the available files.')
    expect(container.textContent).not.toContain('queue lagging')

    unmount()
  })

  it('shows a missing-files panel when PM2 log files are unavailable on the host', () => {
    const { container, unmount } = renderPanel(buildPm2Logs({
      files: [
        { path: '/var/log/tamtam/out.log', size: null, mtime: null, error: 'ENOENT' },
        { path: '/var/log/tamtam/error.log', size: null, mtime: null, error: 'ENOENT' },
      ],
      entries: [],
    }))

    expect(container.textContent).toContain('PM2 log files were not found on this host.')
    expect(container.textContent).toContain('/var/log/tamtam/out.log')
    expect(container.textContent).toContain('/var/log/tamtam/error.log')

    unmount()
  })
})
