/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ProjectRunsTab } from '@/components/ProjectRunsTab'
import type { JobInfo } from '@/lib/client-api'

const { pushMock, fetchJobsMock, releaseProjectMock, pushProjectMock, syncJobBoardMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  fetchJobsMock: vi.fn(),
  releaseProjectMock: vi.fn(),
  pushProjectMock: vi.fn(),
  syncJobBoardMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

vi.mock('@/lib/client-api', () => ({
  fetchJobs: fetchJobsMock,
  releaseProject: releaseProjectMock,
  pushProject: pushProjectMock,
  syncJobBoard: syncJobBoardMock,
}))

function makeJob({
  id,
  kind,
  started_at,
  ...overrides
}: Partial<JobInfo> & { id: string; kind: string; started_at: number }): JobInfo {
  return {
    id,
    kind,
    started_at,
    project: 'alpha',
    prompt: null,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    finished_at: started_at + 5,
    seen: true,
    ...overrides,
  } as JobInfo
}

function renderTab(props: Partial<React.ComponentProps<typeof ProjectRunsTab>> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const render = (nextProps: Partial<React.ComponentProps<typeof ProjectRunsTab>> = {}) => {
    flushSync(() => {
      root.render(React.createElement(ProjectRunsTab, {
        projectName: 'alpha',
        jobsPaused: false,
        ...nextProps,
      }))
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
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim().startsWith(text))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

function makeResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
  }
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
    pushProjectMock.mockResolvedValue({ status: 'started', job_id: 'commit-retry' })
    syncJobBoardMock.mockResolvedValue({ status: 'ok' })
  })

  afterEach(() => {
    pushMock.mockReset()
    fetchJobsMock.mockReset()
    releaseProjectMock.mockReset()
    pushProjectMock.mockReset()
    syncJobBoardMock.mockReset()
    vi.unstubAllGlobals()
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

  it('uses the info tone for running summary text and running filter chips', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'running-review', kind: 'review', started_at: 100, finished_at: null, status: 'running', exit_code: null }),
      ],
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(container.textContent).toContain('1 running')
    })

    const runningSummary = Array.from(container.querySelectorAll('span')).find((node) => node.textContent?.trim() === '1 running')
    if (!(runningSummary instanceof HTMLSpanElement)) throw new Error('running summary not found')

    const runningFilter = buttonByText(container, 'running')
    expect(runningSummary.className).toContain('text-status-info')
    expect(runningSummary.className).not.toContain('text-status-warning')
    expect(runningFilter.className).toContain('text-status-info')
    expect(runningFilter.className).not.toContain('text-status-warning')

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

  it('shows retry commit for the newest release when its commit step failed', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'rel-commit-failed', kind: 'release', started_at: 100, finished_at: 140, exit_code: 1 }),
        makeJob({ id: 'review-ok', kind: 'review', started_at: 110, finished_at: 120, exit_code: 0, verdict: 'LGTM' }),
        makeJob({ id: 'commit-failed', kind: 'commit', started_at: 125, finished_at: 135, exit_code: 1 }),
      ],
      pendingReleaseProjects: [],
    })
    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(buttonByText(container, 'Retry commit')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Retry commit').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(pushProjectMock).toHaveBeenCalledWith('alpha', {
        commit: true,
        releaseId: 'rel-commit-failed',
      })
    })
    expect(releaseProjectMock).not.toHaveBeenCalled()

    unmount()
  })

  it('keeps Sync board available for aborted finished rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('settings offline')))
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'aborted-release', kind: 'release', started_at: 100, finished_at: 120, status: 'aborted', exit_code: -3 }),
      ],
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(buttonByText(container, 'Sync board')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Sync board').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(syncJobBoardMock).toHaveBeenCalledWith('aborted-release')
    })

    vi.unstubAllGlobals()
    unmount()
  })

  it('aborts a running release through the release abort endpoint', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ status: 'aborted' }))
    vi.stubGlobal('fetch', fetchMock)
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'running-release', kind: 'release', started_at: 100, finished_at: null, status: 'running', exit_code: null }),
        makeJob({ id: 'running-test', kind: 'test', started_at: 110, finished_at: null, status: 'running', exit_code: null, release_id: 'running-release', parent_job_id: 'running-release' }),
      ],
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(buttonByText(container, 'Stop')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Stop').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/projects/by-project/alpha/release/abort', { method: 'POST' })
    })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/jobs/running-release', expect.anything())

    unmount()
  })

  it('treats abort-pending release responses as accepted stops', async () => {
    const fetchMock = vi.fn(async () => makeResponse({
      status: 'abort_pending',
      detail: 'Timed out waiting for commit to stop cleanly',
      release_id: 'running-release',
      killed_job_id: null,
    }, false, 409))
    vi.stubGlobal('fetch', fetchMock)
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'running-release', kind: 'release', started_at: 100, finished_at: null, status: 'running', exit_code: null }),
        makeJob({ id: 'running-commit', kind: 'commit', started_at: 110, finished_at: null, status: 'running', exit_code: null, release_id: 'running-release', parent_job_id: 'running-release' }),
      ],
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(buttonByText(container, 'Stop')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Stop').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/projects/by-project/alpha/release/abort', { method: 'POST' })
      expect(buttonByText(container, 'abort pending')).toBeInstanceOf(HTMLButtonElement)
    })
    expect(container.textContent).not.toContain('failed')
    expect(fetchJobsMock).toHaveBeenCalledTimes(2)

    unmount()
  })

  it('aborts a running release from a flat pipeline-child kind filter', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ status: 'aborted' }))
    vi.stubGlobal('fetch', fetchMock)
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'running-release', kind: 'release', started_at: 100, finished_at: null, status: 'running', exit_code: null }),
        makeJob({ id: 'running-test', kind: 'test', started_at: 110, finished_at: null, status: 'running', exit_code: null, release_id: 'running-release', parent_job_id: 'running-release' }),
      ],
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(buttonByText(container, 'test')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'test').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Test run')
      expect(buttonByText(container, 'Stop')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Stop').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/projects/by-project/alpha/release/abort', { method: 'POST' })
    })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/jobs/running-test', expect.anything())

    unmount()
  })

  it('cancels a normal running job through the job delete endpoint', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ status: 'cancelled' }))
    vi.stubGlobal('fetch', fetchMock)
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'running-review', kind: 'review', started_at: 100, finished_at: null, status: 'running', exit_code: null }),
      ],
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(buttonByText(container, 'Stop')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Stop').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/jobs/running-review', { method: 'DELETE' })
    })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/projects/by-project/alpha/release/abort', expect.anything())

    unmount()
  })

  it('aborts an attached running release instead of deleting the finished parent job', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ status: 'aborted' }))
    vi.stubGlobal('fetch', fetchMock)
    fetchJobsMock.mockResolvedValue({
      jobs: [
        makeJob({ id: 'agent-run', kind: 'agent:ship', started_at: 100, finished_at: 110, status: 'done', exit_code: 0 }),
        makeJob({ id: 'nested-release', kind: 'release', started_at: 120, finished_at: null, status: 'running', exit_code: null, parent_job_id: 'agent-run' }),
        makeJob({ id: 'nested-test', kind: 'test', started_at: 130, finished_at: null, status: 'running', exit_code: null, release_id: 'nested-release', parent_job_id: 'nested-release' }),
      ],
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(buttonByText(container, 'Stop')).toBeInstanceOf(HTMLButtonElement)
    })

    buttonByText(container, 'Stop').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/projects/by-project/alpha/release/abort', { method: 'POST' })
    })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/jobs/agent-run', expect.anything())

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

  it('disables release retry while jobs are paused and re-enables it live', async () => {
    const { container, rerender, unmount } = renderTab({ jobsPaused: true })

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(buttonByText(container, 'Continue release').disabled).toBe(true)
      expect(buttonByText(container, 'Continue release').title).toContain('Jobs are paused globally')
    })

    buttonByText(container, 'Continue release').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(releaseProjectMock).not.toHaveBeenCalled()

    rerender({ jobsPaused: false })

    await vi.waitFor(() => {
      expect(buttonByText(container, 'Continue release').disabled).toBe(false)
      expect(buttonByText(container, 'Continue release').title).toContain('Start a new release attempt')
    })

    unmount()
  })

  it('links the queued release banner to the current project pipeline view', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [],
      pendingReleaseProjects: ['alpha'],
    })

    const { container, unmount } = renderTab()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith('alpha', { limit: 0 })
      expect(container.textContent).toContain('Release queued')
    })

    const bannerLink = Array.from(container.querySelectorAll('a')).find((node) => node.textContent?.includes('Release queued'))
    if (!(bannerLink instanceof HTMLAnchorElement)) throw new Error('queued release banner link not found')

    expect(bannerLink.getAttribute('href')).toBe('/pipeline?project=alpha')

    unmount()
  })
})
