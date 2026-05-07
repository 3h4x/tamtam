/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ChangesTab } from '@/components/ChangesTab'
import type { ChangesResponse } from '@/lib/client-api'

const { pushMock, fetchChangesMock, pushProjectMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  fetchChangesMock: vi.fn(),
  pushProjectMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchChanges: fetchChangesMock,
  fetchChangeDiff: vi.fn(),
  pullProject: vi.fn(),
  pushProject: pushProjectMock,
  PullDivergedError: class PullDivergedError extends Error {},
  checkoutDefaultBranch: vi.fn(),
}))

function buildChangesResponse(overrides: Partial<ChangesResponse> = {}): ChangesResponse {
  return {
    files: [],
    totalFiles: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    branch: 'master',
    defaultBranch: 'master',
    ahead: 3,
    behind: 0,
    branchMerged: false,
    openPrUrl: null,
    ...overrides,
  }
}

function renderChangesTab(props: React.ComponentProps<typeof ChangesTab>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const render = (nextProps: React.ComponentProps<typeof ChangesTab>) => {
    flushSync(() => {
      root.render(React.createElement(ChangesTab, nextProps))
    })
  }

  render(props)

  return {
    container,
    rerender: render,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

describe('ChangesTab', () => {
  beforeEach(() => {
    pushMock.mockReset()
    fetchChangesMock.mockReset()
    pushProjectMock.mockReset()
    fetchChangesMock.mockResolvedValue(buildChangesResponse())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('disables ahead-of-origin push while jobs are paused and re-enables it live', async () => {
    const { container, rerender, unmount } = renderChangesTab({
      projectName: 'acme/widgets',
      jobsPaused: true,
    })

    await vi.waitFor(() => {
      expect(fetchChangesMock).toHaveBeenCalledWith('acme/widgets', expect.anything())
      expect(buttonByText(container, 'Push 3 commits').disabled).toBe(true)
      expect(buttonByText(container, 'Push 3 commits').title).toContain('Jobs are paused globally')
    })

    buttonByText(container, 'Push 3 commits').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushProjectMock).not.toHaveBeenCalled()

    rerender({
      projectName: 'acme/widgets',
      jobsPaused: false,
    })

    await vi.waitFor(() => {
      expect(buttonByText(container, 'Push 3 commits').disabled).toBe(false)
      expect(buttonByText(container, 'Push 3 commits').title).toContain('Push 3 commits to origin')
    })

    unmount()
  })
})
