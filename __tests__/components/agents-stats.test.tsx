/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

const { pushMock, useSchedulerHealthMock, useAgentStatsMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  useSchedulerHealthMock: vi.fn(),
  useAgentStatsMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/hooks/useSchedulerHealth', () => ({
  useSchedulerHealth: useSchedulerHealthMock,
}))

vi.mock('@/hooks/useAgentStats', () => ({
  useAgentStats: useAgentStatsMock,
}))

import { AgentsStats } from '@/components/project-detail/AgentsStats'

function render(projectName = 'alpha') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(<AgentsStats projectName={projectName} />)
  })
  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

describe('AgentsStats', () => {
  beforeEach(() => {
    pushMock.mockReset()
    useSchedulerHealthMock.mockReset()
    useAgentStatsMock.mockReset()
    useAgentStatsMock.mockReturnValue({ byName: new Map(), loading: false, refresh: vi.fn() })
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('renders empty state when there are no scheduled agents', () => {
    useSchedulerHealthMock.mockReturnValue({ entries: [], loading: false, refresh: vi.fn() })
    const { container, unmount } = render()
    expect(container.textContent).toContain('No scheduled agents')

    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Open Agents tab'))
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushMock).toHaveBeenCalledWith('/project/alpha/agents')
    unmount()
  })

  it('renders the scheduled agents list and routes to the agent on click', () => {
    const future = Date.now() + 47 * 60_000
    useSchedulerHealthMock.mockReturnValue({
      entries: [
        {
          agentId: 'agent-1',
          project: 'alpha',
          name: 'docs-claude',
          schedule: '24h',
          enabled: true,
          nextFireMs: future,
          lastFireMs: null,
          fireCount: 5,
          errorCount: 0,
          lastError: null,
          skippedCount: 0,
          lastSkippedReason: null,
          lastJobMs: null,
        },
      ],
      loading: false,
      refresh: vi.fn(),
    })
    const { container, unmount } = render()
    expect(container.textContent).toContain('docs-claude')
    expect(container.textContent).toContain('24h')
    expect(container.textContent).toContain('fired 5')

    const row = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('docs-claude'))
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushMock).toHaveBeenCalledWith('/project/alpha/agents?agent=agent-1')
    unmount()
  })

  it('shows aggregated stats per agent (avg duration, tokens, cost, files, fixes)', () => {
    useSchedulerHealthMock.mockReturnValue({
      entries: [
        {
          agentId: 'agent-r',
          project: 'alpha',
          name: 'review',
          schedule: '24h',
          enabled: true,
          nextFireMs: Date.now() + 60_000,
          lastFireMs: null,
          fireCount: 4,
          errorCount: 0,
          lastError: null,
          skippedCount: 0,
          lastSkippedReason: null,
          lastJobMs: null,
        },
      ],
      loading: false,
      refresh: vi.fn(),
    })
    useAgentStatsMock.mockReturnValue({
      byName: new Map([
        ['review', {
          name: 'review',
          runs: 4,
          finishedRuns: 4,
          successfulRuns: 3,
          avgDurationMs: 73000,
          totalDurationMs: 292000,
          inputTokens: 12000,
          outputTokens: 3000,
          cacheReadTokens: 80000,
          cacheCreateTokens: 2000,
          costUsd: 0.42,
          modifiedFilesCount: 11,
          reviewFixesTriggered: 7,
        }],
      ]),
      loading: false,
      refresh: vi.fn(),
    })
    const { container, unmount } = render()
    expect(container.textContent).toContain('4 runs')
    expect(container.textContent).toContain('avg 1.2m')
    expect(container.textContent).toContain('75% success')
    expect(container.textContent).toContain('97.0k tok')
    expect(container.textContent).toContain('$0.42')
    expect(container.textContent).toContain('11 files touched')
    expect(container.textContent).toContain('7 fixes triggered')
    // Header aggregate
    expect(container.textContent).toContain('4 total runs')
    unmount()
  })

  it('surfaces errors and skipped reasons when present', () => {
    useSchedulerHealthMock.mockReturnValue({
      entries: [
        {
          agentId: 'agent-2',
          project: 'alpha',
          name: 'flaky',
          schedule: '1h',
          enabled: true,
          nextFireMs: Date.now() + 60_000,
          lastFireMs: Date.now() - 30_000,
          fireCount: 3,
          errorCount: 1,
          lastError: 'pm2 not available',
          skippedCount: 0,
          lastSkippedReason: null,
          lastJobMs: null,
        },
      ],
      loading: false,
      refresh: vi.fn(),
    })
    const { container, unmount } = render()
    expect(container.textContent).toContain('errors 1')
    expect(container.textContent).toContain('pm2 not available')
    unmount()
  })
})
