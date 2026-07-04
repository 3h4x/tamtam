/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { CloseIssueControl } from '@/components/issues-tab/CloseIssueControl'

const { closeIssue } = vi.hoisted(() => ({ closeIssue: vi.fn() }))

vi.mock('@/lib/client-api', () => ({ closeIssue }))

function render(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => root.render(node))
  return {
    container,
    unmount: () => { root.unmount(); container.remove() },
  }
}

function click(el: Element | null | undefined) {
  flushSync(() => el?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function findButton(container: Element, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
}

describe('CloseIssueControl', () => {
  beforeEach(() => {
    closeIssue.mockReset()
    closeIssue.mockResolvedValue({ status: 'closed', number: 42, reason: 'not planned', repo: 'acme/widgets' })
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('is collapsed to a single Close button by default (no reason picker shown)', () => {
    const { container, unmount } = render(
      React.createElement(CloseIssueControl, { projectName: 'acme/widgets', issueNumber: 42, onClosed: vi.fn() }),
    )
    expect(findButton(container, 'Close')).toBeTruthy()
    // reason options are not visible until the operator expands the control
    expect(container.textContent).not.toContain('not planned')
    unmount()
  })

  it('closes as the selected reason and calls onClosed', async () => {
    const onClosed = vi.fn()
    const { container, unmount } = render(
      React.createElement(CloseIssueControl, { projectName: 'acme/widgets', issueNumber: 42, onClosed }),
    )

    // Expand
    click(findButton(container, 'Close'))
    expect(container.textContent).toContain('not planned')

    // Pick "not planned"
    click(findButton(container, 'not planned'))
    // Confirm
    click(findButton(container, 'Close issue'))

    await vi.waitFor(() => {
      expect(closeIssue).toHaveBeenCalledWith('acme/widgets', 42, 'not planned')
      expect(onClosed).toHaveBeenCalledWith(42)
    })
    unmount()
  })

  it('defaults the reason to completed', async () => {
    const onClosed = vi.fn()
    const { container, unmount } = render(
      React.createElement(CloseIssueControl, { projectName: 'acme/widgets', issueNumber: 7, onClosed }),
    )
    click(findButton(container, 'Close'))
    click(findButton(container, 'Close issue'))
    await vi.waitFor(() => {
      expect(closeIssue).toHaveBeenCalledWith('acme/widgets', 7, 'completed')
      expect(onClosed).toHaveBeenCalledWith(7)
    })
    unmount()
  })

  it('surfaces an error and does not call onClosed when the close fails', async () => {
    closeIssue.mockRejectedValue(new Error('gh issue close failed'))
    const onClosed = vi.fn()
    const { container, unmount } = render(
      React.createElement(CloseIssueControl, { projectName: 'acme/widgets', issueNumber: 42, onClosed }),
    )
    click(findButton(container, 'Close'))
    click(findButton(container, 'Close issue'))
    await vi.waitFor(() => {
      expect(container.textContent).toContain('gh issue close failed')
    })
    expect(onClosed).not.toHaveBeenCalled()
    unmount()
  })
})
