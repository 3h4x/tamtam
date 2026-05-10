/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { PipelinePage } from '@/components/PipelinePage'
import type { PipelineResponse } from '@/app/api/stats/pipeline/route'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
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

function makePipelineResponse(overrides: Partial<PipelineResponse> = {}): PipelineResponse {
  return {
    window: '30d',
    generatedAt: new Date('2026-05-10T10:00:00Z').getTime(),
    project: null,
    verdicts: {
      lgtm: 3,
      needsAttention: 1,
      doNotShip: 0,
      parseFailed: 0,
      prunedMissingVerdict: 0,
      total: 4,
    },
    fixLoop: {
      total: 1,
      converged: 1,
      hitCap: 0,
      avgIterations: 1,
    },
    pipelineSuccess: {
      succeeded: 2,
      failed: 1,
      total: 3,
      rate: 2 / 3,
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
    projects: [],
    configSnapshot: {
      verdictRules: 'Emit LGTM or NEEDS ATTENTION.',
      commitStyle: 'Conventional commits.',
      maxStepIterations: 3,
      maxFixPushAttempts: 2,
      stepWindowSeconds: 1800,
    },
    ...overrides,
  }
}

function makeResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  }
}

function renderPipelinePage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(PipelinePage))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('PipelinePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('labels release and step-duration metrics to match the rendered avg values', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/stats/pipeline?window=30d') {
        return makeResponse(makePipelineResponse())
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderPipelinePage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Avg successful release time')
      expect(container.textContent).toContain('median 1m 20s · p95 2m · 2 successful releases')
      expect(container.textContent).toContain('Avg, median, and p95 wall-clock time per pipeline step')
      expect(container.textContent).not.toContain('Median release time')
    })

    unmount()
  })
})
