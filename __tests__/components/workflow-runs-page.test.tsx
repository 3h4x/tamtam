/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { WorkflowRunsPage } from '@/components/workflow-runs/WorkflowRunsPage'

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

vi.mock('@/components/workflow-runs/WorkflowGraph', () => ({
  WorkflowGraph: () => <div>graph</div>,
}))

vi.mock('@/components/ui/StandardTabs', () => ({
  StandardTabs: ({
    items,
    activeTab,
  }: {
    items: Array<{ id: string; label: string }>
    activeTab: string
  }) => <div>{items.find((item) => item.id === activeTab)?.label}</div>,
}))

function renderWorkflowRunsPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(<WorkflowRunsPage />)
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('WorkflowRunsPage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T12:00:00Z'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows relative start age and live elapsed duration for active runs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        runs: [
          {
            id: 'run-live',
            name: 'release',
            rawName: 'release',
            status: 'running',
            createdAt: '2026-05-20T11:57:30Z',
            startedAt: '2026-05-20T11:58:00Z',
            completedAt: null,
            durationMs: null,
            input: ['acme'],
            output: null,
            error: null,
          },
          {
            id: 'run-done',
            name: 'test',
            rawName: 'test',
            status: 'completed',
            createdAt: '2026-05-20T11:49:00Z',
            startedAt: '2026-05-20T11:50:00Z',
            completedAt: '2026-05-20T11:50:30Z',
            durationMs: 30_000,
            input: ['acme'],
            output: { ok: true },
            error: null,
          },
        ],
        meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
      }),
    }))

    const { container, unmount } = renderWorkflowRunsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('2m ago')
      expect(container.textContent).toContain('2.0 m')
      expect(container.textContent).toContain('30.0 s')
    })

    const startedCell = Array.from(container.querySelectorAll('td')).find((cell) => cell.textContent === '2m ago')
    expect(startedCell?.getAttribute('title')).toBe(new Date('2026-05-20T11:58:00Z').toLocaleString())

    unmount()
  })
})
