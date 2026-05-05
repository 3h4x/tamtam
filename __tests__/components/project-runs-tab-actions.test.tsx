/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ProjectRunsTab } from '@/components/ProjectRunsTab'
import type { JobInfo } from '@/lib/client-api'

const { pushMock, fetchJobsMock, releaseProjectMock, syncJobBoardMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  fetchJobsMock: vi.fn(),
  releaseProjectMock: vi.fn(),
  syncJobBoardMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchJobs: fetchJobsMock,
  releaseProject: releaseProjectMock,
  syncJobBoard: syncJobBoardMock,
}))

function makeJob(overrides: Partial<JobInfo> & { id: string; kind: string; started_at: number }): JobInfo {
  return {
    project: 'alpha',
    prompt: null,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    finished_at: overrides.started_at + 5,
    seen: true,
    ...overrides,
  } as JobInfo
}

function renderTab() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(ProjectRunsTab, { projectName: 'alpha' }))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim().startsWith(text))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

describe('ProjectRunsTab release actions', () => {
  beforeEach(() => {
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'real-release', kind: 'release', started_at: 10, finished_at: 15, exit_code: 0 }),
        makeJob({ id: 'old-test', kind: 'test', started_at: 100, finished_at: 110 }),
        makeJob({ id: 'old-push', kind: 'push', started_at: 120, finished_at: 130, exit_code: 1 }),
        makeJob({ id: 'new-test', kind: 'test', started_at: 2200, finished_at: 2210 }),
        makeJob({ id: 'new-push', kind: 'push', started_at: 2220, finished_at: 2230, exit_code: 1 }),
      ],
      pendingReleaseProjects: [],
    })
    releaseProjectMock.mockResolvedValue({
      status: 'started',
      release_job_id: 'rel-2',
      message: 'started',
    })
    syncJobBoardMock.mockResolvedValue({ status: 'ok' })
  })

  afterEach(() => {
    pushMock.mockReset()
    fetchJobsMock.mockReset()
    releaseProjectMock.mockReset()
    syncJobBoardMock.mockReset()
    document.body.innerHTML = ''
  })

  it('shows continue release only for the newest virtual grouped pipeline in failed and release filters', async () => {
    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(container.textContent).toContain('Pipeline steps')
    })

    buttonByText(container, 'release').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      const continueButtons = Array.from(container.querySelectorAll('button')).filter((node) => node.textContent?.trim() === 'Continue release')
      expect(continueButtons).toHaveLength(1)
      expect(container.textContent?.match(/Pipeline steps/g)?.length).toBe(2)
    })

    buttonByText(container, 'release').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      const continueButtons = Array.from(container.querySelectorAll('button')).filter((node) => node.textContent?.trim() === 'Continue release')
      expect(continueButtons).toHaveLength(1)
      expect(container.textContent?.match(/Pipeline steps/g)?.length).toBe(2)
    })

    buttonByText(container, 'Continue release').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(releaseProjectMock).toHaveBeenCalledWith('alpha', {
        queueIfBlocked: true,
        sourceJobId: 'new-push',
      })
    })

    unmount()
  })

  it('keeps Sync board available even if an unrelated global fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('settings offline')))
    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(buttonByText(container, 'Sync board')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Sync board').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(syncJobBoardMock).toHaveBeenCalledWith('new-push')
    })

    vi.unstubAllGlobals()
    unmount()
  })

  it('hides retry on an older top-level release when a newer nested release exists under an agent run', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'old-release', kind: 'release', started_at: 10, finished_at: 20, exit_code: 1 }),
        makeJob({ id: 'agent-run', kind: 'agent:ship', started_at: 100, finished_at: 110, parent_job_id: null }),
        makeJob({ id: 'nested-release', kind: 'release', started_at: 200, finished_at: 240, exit_code: 1, parent_job_id: 'agent-run' }),
        makeJob({ id: 'nested-test', kind: 'test', started_at: 210, finished_at: 220, exit_code: 0 }),
        makeJob({ id: 'nested-push', kind: 'push', started_at: 225, finished_at: 235, exit_code: 1 }),
      ],
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(container.textContent).toContain('Release pipeline')
      expect(container.textContent).toContain('ship')
    })

    expect(Array.from(container.querySelectorAll('button')).some((node) => node.textContent?.trim() === 'Retry release')).toBe(false)
    expect(Array.from(container.querySelectorAll('button')).some((node) => node.textContent?.trim() === 'Continue release')).toBe(false)

    const expandButton = Array.from(container.querySelectorAll('button')).find((node) => node.getAttribute('title') === 'Expand steps')
    if (!(expandButton instanceof HTMLButtonElement)) throw new Error('expand button not found')
    expandButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      const continueButtons = Array.from(container.querySelectorAll('button')).filter((node) => node.textContent?.trim() === 'Continue release')
      const retryButtons = Array.from(container.querySelectorAll('button')).filter((node) => node.textContent?.trim() === 'Retry release')
      expect(continueButtons).toHaveLength(1)
      expect(retryButtons).toHaveLength(0)
    })

    buttonByText(container, 'Continue release').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(releaseProjectMock).toHaveBeenCalledWith('alpha', {
        queueIfBlocked: true,
        sourceJobId: 'nested-release',
      })
    })

    unmount()
  })

  it('keeps continue release visible for the latest grouped pipeline when mark-dod is the last successful step', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'review-lgtm', kind: 'review', started_at: 100, finished_at: 110, verdict: 'LGTM' }),
        makeJob({ id: 'dod-success', kind: 'mark-dod', started_at: 120, finished_at: 130, exit_code: 0 }),
      ],
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(container.textContent).toContain('Pipeline steps')
    })

    await vi.waitFor(() => {
      const continueButtons = Array.from(container.querySelectorAll('button')).filter((node) => node.textContent?.trim() === 'Continue release')
      expect(continueButtons).toHaveLength(1)
    })

    buttonByText(container, 'Continue release').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(releaseProjectMock).toHaveBeenCalledWith('alpha', {
        queueIfBlocked: true,
        sourceJobId: 'dod-success',
      })
    })

    unmount()
  })
})
