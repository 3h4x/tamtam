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

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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
      ok: true,
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
      expect(container.textContent).toContain('active now')
      expect(container.textContent).toContain('1 run')
    })

    const activePanel = container.querySelector('section[aria-label="Active workflow runs"]')
    expect(activePanel?.textContent).toContain('release')
    expect(activePanel?.textContent).toContain('acme')
    expect(activePanel?.querySelector('a')?.getAttribute('href')).toBe('/workflow-runs/run-live')

    const startedCell = Array.from(container.querySelectorAll('td')).find((cell) => cell.textContent === '2m ago')
    expect(startedCell?.getAttribute('title')).toBe(new Date('2026-05-20T11:58:00Z').toLocaleString())

    unmount()
  })

  it('keeps the last successful runs visible when a refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
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
          ],
          meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
        }),
      })
      .mockRejectedValueOnce(new Error('network down')))

    const { container, unmount } = renderWorkflowRunsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('release')
    })

    await vi.advanceTimersByTimeAsync(5000)

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Refresh failed. Showing last successful results.')
      expect(container.textContent).toContain('network down')
      expect(container.textContent).toContain('release')
    })

    unmount()
  })

  it('shows the initial load error when a successful response has invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('Unexpected end of JSON input')
      },
    }))

    const { container, unmount } = renderWorkflowRunsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to load workflow runs')
      expect(container.textContent).toContain('Unexpected end of JSON input')
      expect(container.textContent).toContain('Retry')
    })

    unmount()
  })

  it('keeps the last successful runs visible when a successful refresh has invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
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
          ],
          meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Unexpected end of JSON input')
        },
      }))

    const { container, unmount } = renderWorkflowRunsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('release')
    })

    await vi.advanceTimersByTimeAsync(5000)

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Refresh failed. Showing last successful results.')
      expect(container.textContent).toContain('Unexpected end of JSON input')
      expect(container.textContent).toContain('release')
    })

    unmount()
  })

  it('constrains long failed outcomes in the mobile card layout', async () => {
    const error = 'failed because the workflow command produced a very long first line that should not overflow'
    const expectedLabel = error.slice(0, 60)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runs: [
          {
            id: 'run-failed',
            name: 'review',
            rawName: 'workflow.review',
            status: 'failed',
            createdAt: '2026-05-20T11:49:00Z',
            startedAt: '2026-05-20T11:50:00Z',
            completedAt: '2026-05-20T11:50:30Z',
            durationMs: 30_000,
            input: ['acme'],
            output: null,
            error,
          },
        ],
        meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
      }),
    }))

    const { container, unmount } = renderWorkflowRunsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain(expectedLabel)
    })

    const mobileCard = container.querySelector<HTMLAnchorElement>('a.block[href="/workflow-runs/run-failed"]')
    const outcome = Array.from(mobileCard?.querySelectorAll('span') ?? []).find((span) => span.textContent === expectedLabel)
    expect(outcome?.className).toContain('max-w-[45%]')
    expect(outcome?.className).toContain('truncate')
    expect(outcome?.getAttribute('title')).toBe(error)

    unmount()
  })

  it('uses lifecycle marks and matching active tones in status filters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runs: [
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
          {
            id: 'run-failed',
            name: 'review',
            rawName: 'review',
            status: 'failed',
            createdAt: '2026-05-20T11:49:00Z',
            startedAt: '2026-05-20T11:50:00Z',
            completedAt: '2026-05-20T11:50:30Z',
            durationMs: 30_000,
            input: ['acme'],
            output: null,
            error: 'failed',
          },
        ],
        meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
      }),
    }))

    const { container, unmount } = renderWorkflowRunsPage()

    await vi.waitFor(() => {
      const filters = container.querySelector('[role="group"][aria-label="Status filter"]')
      expect(filters?.textContent).toContain('✓')
      expect(filters?.textContent).toContain('✗')
    })

    const failedButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('failed'))
    expect(failedButton).toBeDefined()

    flushSync(() => {
      failedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(failedButton?.getAttribute('aria-pressed')).toBe('true')
    expect(failedButton?.className).toContain('text-status-error')

    unmount()
  })

  it('filters runs by trigger and derived outcome text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runs: [
          {
            id: 'run-review',
            name: 'review',
            rawName: 'workflow.review',
            status: 'completed',
            createdAt: '2026-05-20T11:49:00Z',
            startedAt: '2026-05-20T11:50:00Z',
            completedAt: '2026-05-20T11:50:30Z',
            durationMs: 30_000,
            input: ['acme', { parentJobId: 'release-123' }],
            output: { verdict: 'LGTM' },
            error: null,
          },
          {
            id: 'run-push',
            name: 'push',
            rawName: 'workflow.push',
            status: 'completed',
            createdAt: '2026-05-20T11:45:00Z',
            startedAt: '2026-05-20T11:46:00Z',
            completedAt: '2026-05-20T11:46:30Z',
            durationMs: 30_000,
            input: ['acme', { reason: 'nightly sync' }],
            output: { dispatched: false },
            error: null,
          },
          {
            id: 'run-test',
            name: 'test',
            rawName: 'workflow.test',
            status: 'failed',
            createdAt: '2026-05-20T11:40:00Z',
            startedAt: '2026-05-20T11:41:00Z',
            completedAt: '2026-05-20T11:41:30Z',
            durationMs: 30_000,
            input: ['beta'],
            output: { exitCode: 1 },
            error: 'exit 1',
          },
        ],
        meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
      }),
    }))

    const { container, unmount } = renderWorkflowRunsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('review')
      expect(container.textContent).toContain('push')
      expect(container.textContent).toContain('test')
    })

    const filterInput = container.querySelector<HTMLInputElement>('input[placeholder*="Filter workflow"]')
    expect(filterInput).toBeTruthy()

    flushSync(() => {
      if (!filterInput) throw new Error('filter input not found')
      setInputValue(filterInput, 'nightly')
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('1 of 3 recent')
      expect(container.textContent).toContain('push')
      expect(container.textContent).not.toContain('review')
      expect(container.textContent).not.toContain('test')
    })

    flushSync(() => {
      if (!filterInput) throw new Error('filter input not found')
      setInputValue(filterInput, 'LGTM')
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('1 of 3 recent')
      expect(container.textContent).toContain('review')
      expect(container.textContent).not.toContain('push')
      expect(container.textContent).not.toContain('test')
    })

    unmount()
  })

  it('surfaces failed and cancelled runs as attention shortcuts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runs: [
          {
            id: 'run-review',
            name: 'review',
            rawName: 'workflow.review',
            status: 'failed',
            createdAt: '2026-05-20T11:49:00Z',
            startedAt: '2026-05-20T11:50:00Z',
            completedAt: '2026-05-20T11:50:30Z',
            durationMs: 30_000,
            input: ['acme'],
            output: null,
            error: 'failed',
          },
          {
            id: 'run-soak',
            name: 'soak',
            rawName: 'workflow.soak',
            status: 'cancelled',
            createdAt: '2026-05-20T11:45:00Z',
            startedAt: '2026-05-20T11:46:00Z',
            completedAt: '2026-05-20T11:46:30Z',
            durationMs: 30_000,
            input: ['acme'],
            output: null,
            error: null,
          },
          {
            id: 'run-test',
            name: 'test',
            rawName: 'workflow.test',
            status: 'completed',
            createdAt: '2026-05-20T11:40:00Z',
            startedAt: '2026-05-20T11:41:00Z',
            completedAt: '2026-05-20T11:41:30Z',
            durationMs: 30_000,
            input: ['beta'],
            output: { ok: true },
            error: null,
          },
        ],
        meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
      }),
    }))

    const { container, unmount } = renderWorkflowRunsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('needs attention')
      expect(container.textContent).toContain('2 recent')
    })

    const cancelledShortcut = container.querySelector<HTMLButtonElement>('button[aria-label="Show cancelled workflow runs"]')
    expect(cancelledShortcut?.textContent).toContain('cancelled')
    expect(cancelledShortcut?.textContent).toContain('1')

    flushSync(() => {
      cancelledShortcut?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('1 of 3 recent')
      expect(container.textContent).toContain('soak')
      expect(container.textContent).not.toContain('review')
      expect(container.textContent).not.toContain('test')
    })

    unmount()
  })

  it('shows failed and cancelled runs in a direct attention panel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runs: [
          {
            id: 'run-review',
            name: 'review',
            rawName: 'workflow.review',
            status: 'failed',
            createdAt: '2026-05-20T11:49:00Z',
            startedAt: '2026-05-20T11:50:00Z',
            completedAt: '2026-05-20T11:50:30Z',
            durationMs: 30_000,
            input: ['acme', { parentJobId: 'release-123' }],
            output: null,
            error: 'review found a blocking issue\nwith details',
          },
          {
            id: 'run-soak',
            name: 'soak',
            rawName: 'workflow.soak',
            status: 'cancelled',
            createdAt: '2026-05-20T11:45:00Z',
            startedAt: '2026-05-20T11:46:00Z',
            completedAt: '2026-05-20T11:46:30Z',
            durationMs: 30_000,
            input: ['acme'],
            output: null,
            error: null,
          },
          {
            id: 'run-test',
            name: 'test',
            rawName: 'workflow.test',
            status: 'completed',
            createdAt: '2026-05-20T11:40:00Z',
            startedAt: '2026-05-20T11:41:00Z',
            completedAt: '2026-05-20T11:41:30Z',
            durationMs: 30_000,
            input: ['beta'],
            output: { ok: true },
            error: null,
          },
        ],
        meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
      }),
    }))

    const { container, unmount } = renderWorkflowRunsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('review found a blocking issue')
    })

    const attentionPanel = container.querySelector('section[aria-label="Workflow runs needing attention"]')
    expect(attentionPanel?.textContent).toContain('2 runs')
    expect(attentionPanel?.textContent).toContain('release-123')
    expect(attentionPanel?.textContent).toContain('cancelled')
    expect(attentionPanel?.textContent).not.toContain('test')

    const links = Array.from(attentionPanel?.querySelectorAll<HTMLAnchorElement>('a') ?? [])
      .map((link) => link.getAttribute('href'))
    expect(links).toEqual(['/workflow-runs/run-review', '/workflow-runs/run-soak'])

    const reviewOutcome = Array.from(attentionPanel?.querySelectorAll<HTMLElement>('[title]') ?? [])
      .find((element) => element.getAttribute('title') === 'review found a blocking issue\nwith details')
    expect(reviewOutcome?.textContent).toBe('review found a blocking issue')

    unmount()
  })
})
