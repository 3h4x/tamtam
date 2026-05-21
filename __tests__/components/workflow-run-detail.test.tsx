/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { WorkflowRunDetail } from '@/components/workflow-runs/WorkflowRunDetail'

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

function renderWorkflowRunDetail(runId: string) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<WorkflowRunDetail runId={runId} />)
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('WorkflowRunDetail', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-21T12:00:00Z'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows relative timing and live durations for active runs and steps', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        run: {
          id: 'run-live',
          name: 'release',
          rawName: 'workflow.release',
          status: 'running',
          createdAt: '2026-05-21T11:57:00Z',
          startedAt: '2026-05-21T11:58:00Z',
          completedAt: null,
          durationMs: null,
          output: null,
          error: null,
        },
        steps: [
          {
            stepId: 'step-review',
            name: 'review',
            rawName: 'workflow.review',
            status: 'running',
            attempt: 2,
            createdAt: '2026-05-21T11:58:30Z',
            startedAt: '2026-05-21T11:59:00Z',
            completedAt: null,
            durationMs: null,
            input: null,
            output: null,
            error: null,
          },
        ],
      }),
    }))

    const { container, unmount } = renderWorkflowRunDetail('run-live')

    await vi.waitFor(() => {
      expect(container.textContent).toContain('3m ago')
      expect(container.textContent).toContain('2m ago')
      expect(container.textContent).toContain('1m ago')
      expect(container.textContent).toContain('2.0 m')
      expect(container.textContent).toContain('1.0 m')
    })

    const runningBadges = Array.from(container.querySelectorAll('[aria-label="status running"]'))
    expect(runningBadges.length).toBeGreaterThan(0)
    expect(runningBadges[0]?.textContent).toContain('⟳')
    expect(runningBadges[0]?.className).toContain('bg-accent/15')

    const runStarted = Array.from(container.querySelectorAll('[title]')).find(
      (element) => element.getAttribute('title') === new Date('2026-05-21T11:58:00Z').toLocaleString(),
    )
    expect(runStarted?.textContent).toBe('2m ago')

    const stepStarted = Array.from(container.querySelectorAll('[title]')).find(
      (element) => element.getAttribute('title') === new Date('2026-05-21T11:59:00Z').toLocaleString(),
    )
    expect(stepStarted?.textContent).toBe('1m ago')

    unmount()
  })

  it('shows a not-found state for pruned or missing runs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ detail: 'missing' }),
    }))

    const { container, unmount } = renderWorkflowRunDetail('missing-run')

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Workflow run not found')
      expect(container.textContent).toContain('Back to workflow runs')
    })

    const backLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href="/workflow-runs"]'))
    expect(backLinks.length).toBeGreaterThan(0)

    unmount()
  })

  it('orders step status rollups by severity then alphabetical unknown statuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        run: {
          id: 'run-done',
          name: 'release',
          rawName: 'workflow.release',
          status: 'completed',
          createdAt: '2026-05-21T11:30:00Z',
          startedAt: '2026-05-21T11:31:00Z',
          completedAt: '2026-05-21T11:35:00Z',
          durationMs: 240_000,
          output: null,
          error: null,
        },
        steps: [
          {
            stepId: 'step-zeta',
            name: 'zeta',
            rawName: 'workflow.zeta',
            status: 'zeta',
            attempt: 1,
            createdAt: '2026-05-21T11:31:00Z',
            startedAt: '2026-05-21T11:31:00Z',
            completedAt: '2026-05-21T11:31:30Z',
            durationMs: 30_000,
            input: null,
            output: null,
            error: null,
          },
          {
            stepId: 'step-running',
            name: 'running',
            rawName: 'workflow.running',
            status: 'running',
            attempt: 1,
            createdAt: '2026-05-21T11:32:00Z',
            startedAt: '2026-05-21T11:32:00Z',
            completedAt: null,
            durationMs: null,
            input: null,
            output: null,
            error: null,
          },
          {
            stepId: 'step-alpha',
            name: 'alpha',
            rawName: 'workflow.alpha',
            status: 'alpha',
            attempt: 1,
            createdAt: '2026-05-21T11:33:00Z',
            startedAt: '2026-05-21T11:33:00Z',
            completedAt: '2026-05-21T11:33:30Z',
            durationMs: 30_000,
            input: null,
            output: null,
            error: null,
          },
          {
            stepId: 'step-completed',
            name: 'completed',
            rawName: 'workflow.completed',
            status: 'completed',
            attempt: 1,
            createdAt: '2026-05-21T11:34:00Z',
            startedAt: '2026-05-21T11:34:00Z',
            completedAt: '2026-05-21T11:34:30Z',
            durationMs: 30_000,
            input: null,
            output: null,
            error: null,
          },
          {
            stepId: 'step-failed',
            name: 'failed',
            rawName: 'workflow.failed',
            status: 'failed',
            attempt: 1,
            createdAt: '2026-05-21T11:35:00Z',
            startedAt: '2026-05-21T11:35:00Z',
            completedAt: '2026-05-21T11:35:30Z',
            durationMs: 30_000,
            input: null,
            output: null,
            error: 'boom',
          },
        ],
      }),
    }))

    const { container, unmount } = renderWorkflowRunDetail('run-done')

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Steps (5)')
    })

    const summaryBadges = Array.from(container.querySelectorAll<HTMLElement>('[aria-label^="status "]'))
      .filter((badge) => /\d$/.test(badge.textContent ?? ''))
      .map((badge) => badge.getAttribute('aria-label'))

    expect(summaryBadges).toEqual([
      'status failed',
      'status running',
      'status completed',
      'status alpha',
      'status zeta',
    ])

    unmount()
  })
})
