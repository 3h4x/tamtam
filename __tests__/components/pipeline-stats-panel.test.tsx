/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { PipelineStatsPanel } from '@/components/project-detail/PipelineStatsPanel'
import type { ProjectPipelineStats } from '@/lib/client-api'

const { fetchProjectPipelineStatsMock } = vi.hoisted(() => ({
  fetchProjectPipelineStatsMock: vi.fn(),
}))

vi.mock('@/lib/client-api', () => ({
  fetchProjectPipelineStats: fetchProjectPipelineStatsMock,
}))

function makePipelineStats(overrides: Partial<ProjectPipelineStats> = {}): ProjectPipelineStats {
  return {
    window: '30d',
    generatedAt: new Date('2026-05-10T10:00:00Z').getTime(),
    project: 'acme/widgets',
    pipelineSuccess: {
      succeeded: 2,
      failed: 1,
      total: 3,
      rate: 2 / 3,
    },
    fixLoop: {
      total: 1,
      converged: 1,
      hitCap: 0,
      avgIterations: 1,
    },
    stepDurations: {
      release: { avg: 90_000, median: 80_000, p95: 120_000, count: 3 },
      test: { avg: 20_000, median: 18_000, p95: 30_000, count: 3 },
    },
    mttr: {
      avg: 90_000,
      median: 80_000,
      p95: 120_000,
      count: 2,
    },
    ...overrides,
  }
}

function renderPanel(projectName = 'acme/widgets') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<PipelineStatsPanel projectName={projectName} />)
  })

  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

describe('PipelineStatsPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchProjectPipelineStatsMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows a stale-data warning when a refresh fails after an initial successful load', async () => {
    fetchProjectPipelineStatsMock
      .mockResolvedValueOnce(makePipelineStats())
      .mockRejectedValueOnce(new Error('network down'))

    const { container, unmount } = renderPanel()

    await vi.waitFor(() => {
      expect(fetchProjectPipelineStatsMock).toHaveBeenCalledWith('acme/widgets', '30d')
      expect(container.textContent).toContain('avg successful release')
      expect(container.textContent).toContain('Updated')
    })

    await vi.advanceTimersByTimeAsync(60_000)

    await vi.waitFor(() => {
      expect(fetchProjectPipelineStatsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Failed to load pipeline stats. Showing last successful snapshot.')
      expect(container.textContent).toContain('avg successful release')
      expect(container.textContent).toContain('Updated')
    })

    unmount()
  })
})
