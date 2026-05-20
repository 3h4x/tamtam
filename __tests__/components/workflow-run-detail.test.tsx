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
})
