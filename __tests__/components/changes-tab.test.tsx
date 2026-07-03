/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ChangesTab } from '@/components/ChangesTab'
import type { ChangesResponse } from '@/lib/client-api'

// Manual push/pull are gone from ChangesTab — unpushed commits ship through the
// automatic Release pipeline, so the "ahead of origin" state offers Release, not
// a raw git push.
const { pushMock, fetchChangesMock, releaseProjectMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  fetchChangesMock: vi.fn(),
  releaseProjectMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchChanges: fetchChangesMock,
  fetchChangeDiff: vi.fn(),
  releaseProject: releaseProjectMock,
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
    releaseProjectMock.mockReset()
    releaseProjectMock.mockResolvedValue({ status: 'started', release_job_id: 'rel-1', message: 'ok' })
    fetchChangesMock.mockResolvedValue(buildChangesResponse())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('ahead-of-origin offers Release (not a manual push) and gates it on jobs pause', async () => {
    const { container, rerender, unmount } = renderChangesTab({
      projectName: 'acme/widgets',
      jobsPaused: true,
    })

    await vi.waitFor(() => {
      expect(fetchChangesMock).toHaveBeenCalledWith('acme/widgets', expect.anything())
      // The old "Push N commits" button is gone; the ahead state now ships via Release.
      expect(Array.from(container.querySelectorAll('button')).some((b) => /Push/i.test(b.textContent ?? ''))).toBe(false)
      expect(container.textContent).toContain('will ship on release')
      expect(buttonByText(container, 'Release').disabled).toBe(true)
      expect(buttonByText(container, 'Release').title).toContain('Jobs are paused globally')
    })

    buttonByText(container, 'Release').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(releaseProjectMock).not.toHaveBeenCalled()

    rerender({
      projectName: 'acme/widgets',
      jobsPaused: false,
    })

    await vi.waitFor(() => {
      expect(buttonByText(container, 'Release').disabled).toBe(false)
      expect(buttonByText(container, 'Release').title).toContain('release pipeline')
    })

    unmount()
  })

  it('a branch behind origin is informational — no manual Pull button', async () => {
    fetchChangesMock.mockResolvedValue(buildChangesResponse({ ahead: 0, behind: 2 }))
    const { container, unmount } = renderChangesTab({
      projectName: 'acme/widgets',
      jobsPaused: false,
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('behind origin')
      expect(container.textContent).toContain('rebases onto origin automatically')
      expect(Array.from(container.querySelectorAll('button')).some((b) => /Pull|Rebase|Merge/i.test(b.textContent ?? ''))).toBe(false)
    })

    unmount()
  })
})
