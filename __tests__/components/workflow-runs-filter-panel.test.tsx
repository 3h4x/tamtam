/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import {
  type StatusFilter,
  WorkflowRunsFilterPanel,
} from '@/components/workflow-runs/WorkflowRunsFilterPanel'

function renderWorkflowRunsFilterPanel(overrides: Partial<React.ComponentProps<typeof WorkflowRunsFilterPanel>> = {}) {
  const props: React.ComponentProps<typeof WorkflowRunsFilterPanel> = {
    nameFilter: '',
    statusFilter: 'failed',
    statusCounts: {
      all: 8,
      completed: 3,
      running: 1,
      pending: 1,
      failed: 2,
      cancelled: 1,
    },
    attentionStatusCounts: {
      all: 3,
      completed: 0,
      running: 0,
      pending: 0,
      failed: 2,
      cancelled: 1,
    },
    resultsSummary: '8 total',
    onNameFilterChange: vi.fn(),
    onStatusFilterChange: vi.fn(),
    onClearFilters: vi.fn(),
    ...overrides,
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(WorkflowRunsFilterPanel, props))
  })

  return {
    container,
    props,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function findFilterButton(container: HTMLElement, status: StatusFilter): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('aria-pressed') !== null && candidate.textContent?.includes(status),
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`${status} filter button not found`)
  return button
}

describe('WorkflowRunsFilterPanel', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps selected status chips in their active tone while inactive chips keep hover affordance', () => {
    const { container, unmount } = renderWorkflowRunsFilterPanel()

    const selectedFailed = findFilterButton(container, 'failed')
    const inactiveRunning = findFilterButton(container, 'running')

    expect(selectedFailed.getAttribute('aria-pressed')).toBe('true')
    expect(selectedFailed.className).toContain('text-status-error')
    expect(selectedFailed.className).toContain('bg-status-error/15')
    expect(selectedFailed.className).not.toContain('hover:bg-bg-primary')
    expect(selectedFailed.className).not.toContain('hover:text-text-primary')

    expect(inactiveRunning.getAttribute('aria-pressed')).toBe('false')
    expect(inactiveRunning.className).toContain('hover:bg-bg-primary')
    expect(inactiveRunning.className).toContain('hover:text-text-primary')

    unmount()
  })
})
