/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { BridgeOverview } from '@/components/BridgeOverview'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))

function makeBridge() {
  return {
    globalPace: {
      status: 'under_pace',
      marginPct: 12,
      bindingProvider: null,
      bindingWindow: null,
      projectedPct: null,
      providers: [],
    },
    projects: [],
    summary: { projects: 0, agentsEnabled: 0, shipping: 0, releasing: 0, attention: 0, paused: 0, idle: 0 },
    throttle: null,
  }
}

function makeSystem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    current: {
      ts: 1_780_000_000_000,
      cpuPct: 44,
      cpuCount: 12,
      load1: 15.1,
      load5: 11,
      load15: 9.8,
      loadPerCore: 1.26,
      memUsedMb: 32604,
      memTotalMb: 32768,
      memPct: 99.5,
      diskUsedPct: 71,
      diskIoMbS: 18.8,
      ...overrides,
    },
    samples: [],
  }
}

// Route fetch calls to the matching fixture. system can be set to null-current
// or made to reject to exercise the "host metrics optional" path.
function stubFetch(opts: { system?: unknown; systemRejects?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/stats/bridge')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(makeBridge()) })
    }
    if (url.includes('/api/stats/system')) {
      if (opts.systemRejects) return Promise.resolve({ ok: false })
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.system ?? makeSystem()) })
    }
    return Promise.reject(new Error(`unexpected url ${url}`))
  }))
}

function renderBridge() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(React.createElement(BridgeOverview))
  })
  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

describe('BridgeOverview host metrics', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders the compact host resource strip from /api/stats/system', async () => {
    stubFetch()
    const { container, unmount } = renderBridge()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('host')
      expect(container.textContent).toContain('cpu')
      expect(container.textContent).toContain('44%')
      expect(container.textContent).toContain('load')
      expect(container.textContent).toContain('1.26×')
      expect(container.textContent).toContain('mem')
      expect(container.textContent).toContain('100%') // 99.5 rounds to 100
      expect(container.textContent).toContain('disk')
      expect(container.textContent).toContain('71%')
      expect(container.textContent).toContain('io')
      expect(container.textContent).toContain('18.8MB/s')
    })

    unmount()
  })

  it('omits disk and io metrics when the host reports them as null', async () => {
    stubFetch({ system: makeSystem({ diskUsedPct: null, diskIoMbS: null }) })
    const { container, unmount } = renderBridge()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('cpu')
    })
    expect(container.textContent).not.toContain('disk')
    expect(container.textContent).not.toContain('io')

    unmount()
  })

  it('still renders the bridge card when system metrics are unavailable', async () => {
    stubFetch({ systemRejects: true })
    const { container, unmount } = renderBridge()

    // Bridge card itself renders (title present) but no host strip.
    // ("host" appears in the subtitle regardless; the strip's metric labels do not.)
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Bridge')
    })
    expect(container.textContent).not.toContain('cpu')
    expect(container.textContent).not.toContain('load')

    unmount()
  })
})
