/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { JobsPage } from '@/components/JobsPage'

const { fetchJobsMock, fetchProjectsMock, pushMock } = vi.hoisted(() => ({
  fetchJobsMock: vi.fn(),
  fetchProjectsMock: vi.fn(),
  pushMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchJobs: fetchJobsMock,
  fetchProjects: fetchProjectsMock,
}))

vi.mock('@/lib/shared/format', () => ({
  formatAgo: (ts: number) => `ago:${ts}`,
}))

function renderJobsPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(JobsPage))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('JobsPage', () => {
  beforeEach(() => {
    fetchJobsMock.mockReset()
    fetchProjectsMock.mockReset()
    pushMock.mockReset()
    fetchJobsMock.mockResolvedValue({
      jobs: [{
        id: 'job-1',
        project: 'acme/widgets',
        kind: 'review',
        prompt: null,
        pid: 123,
        log_path: '/tmp/job-1.log',
        status: 'running',
        exit_code: null,
        started_at: 100,
        finished_at: null,
        seen: false,
        session_id: 'session-12345678',
        model: 'sonnet',
        provider: 'claude',
        work_summary: 'Reviewing the current diff.',
      }],
      total: 1,
      pendingReleaseProjects: [],
    })
    fetchProjectsMock.mockResolvedValue({
      tasks: [{ id: 'acme/widgets' }],
      priorities: [],
      issueCounts: {},
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ settings: { github_board_sync_enabled: 'false' } }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('labels the metadata chip as started instead of live or last', async () => {
    const { container, unmount } = renderJobsPage()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith(undefined, { limit: 200 })
      expect(container.textContent).toContain('startedago:100')
    })

    expect(container.textContent).not.toContain('live')
    expect(container.textContent).not.toContain('last')
    // started label must appear exactly once (MetaChip only, no duplicate span)
    expect(container.textContent!.split('started').length).toBe(2)
    unmount()
  })

  it('uses the same info tone for the running filter chip and running row badge', async () => {
    const { container, unmount } = renderJobsPage()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith(undefined, { limit: 200 })
      expect(container.textContent).toContain('running 1')
    })

    const runningButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('running 1'))
    if (!(runningButton instanceof HTMLButtonElement)) throw new Error('running filter button not found')

    const runningBadge = Array.from(container.querySelectorAll('span')).find((span) => {
      const className = typeof span.className === 'string' ? span.className : ''
      return span.textContent?.includes('running') && className.includes('border-status-info/30')
    })
    if (!(runningBadge instanceof HTMLSpanElement)) throw new Error('running row badge not found')

    expect(runningButton.className).toContain('text-status-info')
    expect(runningButton.className).not.toContain('text-status-warning')
    expect(runningBadge.className).toContain('text-status-info')
    unmount()
  })

  it('uses the bounded jobs page and displays the full server total', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [{
        id: 'job-1',
        project: 'acme/widgets',
        kind: 'review',
        prompt: null,
        pid: 123,
        log_path: '/tmp/job-1.log',
        status: 'done',
        exit_code: 0,
        started_at: 100,
        finished_at: 110,
        seen: true,
      }],
      total: 500,
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderJobsPage()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith(undefined, { limit: 200 })
      expect(container.textContent).toContain('500 total runs')
      expect(container.textContent).toContain('1 loaded')
    })

    unmount()
  })

  it('counts aborted jobs as failed and excludes them from done', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [
        {
          id: 'job-done',
          project: 'acme/widgets',
          kind: 'test',
          prompt: null,
          pid: 1,
          log_path: '/tmp/job-done.log',
          status: 'done',
          exit_code: 0,
          started_at: 100,
          finished_at: 120,
          seen: true,
        },
        {
          id: 'job-aborted',
          project: 'acme/widgets',
          kind: 'release',
          prompt: null,
          pid: 2,
          log_path: '/tmp/job-aborted.log',
          status: 'aborted',
          exit_code: -3,
          started_at: 130,
          finished_at: 140,
          seen: true,
        },
      ],
      total: 2,
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderJobsPage()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith(undefined, { limit: 200 })
      expect(container.textContent).toContain('done 1')
      expect(container.textContent).toContain('failed 1')
    })

    const failedButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('failed 1'))
    if (!(failedButton instanceof HTMLButtonElement)) throw new Error('failed filter button not found')
    failedButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('cancelled')
      expect(container.textContent).not.toContain('run tests')
    })

    unmount()
  })

  it('does not advertise summary-only failed rows in clickable filter chips', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/counts') {
        return {
          ok: true,
          json: async () => ({
            total: 3,
            byKind: { test: 3 },
            byStatus: { running: 0, done: 1, failed: 1, aborted: 1 },
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
            cost: { total: 0, monthToDate: 0 },
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({ settings: { github_board_sync_enabled: 'false' } }),
      }
    }))
    fetchJobsMock.mockResolvedValue({
      jobs: [{
        id: 'job-done',
        project: 'acme/widgets',
        kind: 'test',
        prompt: null,
        pid: 1,
        log_path: '/tmp/job-done.log',
        status: 'done',
        exit_code: 0,
        started_at: 100,
        finished_at: 120,
        seen: true,
      }],
      total: 3,
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderJobsPage()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('3 total runs')
      expect(container.textContent).toContain('done 1')
      expect(container.textContent).not.toContain('failed 2')
    })
    const failedButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('failed'))
    expect(failedButton).toBeUndefined()

    unmount()
  })

  it('does not render the board link when board sync is enabled but both URLs are blank', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        settings: {
          github_board_sync_enabled: 'true',
          github_board_view_url: '',
          github_board_project_url: '   ',
        },
      }),
    }))

    const { container, unmount } = renderJobsPage()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith(undefined, { limit: 200 })
    })

    expect(container.textContent).not.toContain('Board')
    unmount()
  })

  it('hides completed phase labels on successful release rows', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [
        {
          id: 'release-1',
          project: 'acme/widgets',
          kind: 'release',
          prompt: null,
          pid: 1,
          log_path: '/tmp/release-1.log',
          status: 'done',
          exit_code: 0,
          started_at: 100,
          finished_at: 250,
          seen: true,
        },
        {
          id: 'test-1',
          project: 'acme/widgets',
          kind: 'test',
          prompt: null,
          pid: 2,
          log_path: '/tmp/test-1.log',
          status: 'done',
          exit_code: 0,
          started_at: 110,
          finished_at: 120,
          seen: true,
          parent_job_id: 'release-1',
        },
        {
          id: 'review-1',
          project: 'acme/widgets',
          kind: 'review',
          prompt: null,
          pid: 3,
          log_path: '/tmp/review-1.log',
          status: 'done',
          exit_code: 0,
          started_at: 130,
          finished_at: 140,
          seen: true,
          session_id: 'review-session',
          verdict: 'NEEDS ATTENTION',
          parent_job_id: 'test-1',
        },
        {
          id: 'fix-1',
          project: 'acme/widgets',
          kind: 'fix',
          prompt: null,
          pid: 4,
          log_path: '/tmp/fix-1.log',
          status: 'done',
          exit_code: 0,
          started_at: 180,
          finished_at: 200,
          seen: true,
          parent_job_id: 'review-1',
        },
        {
          id: 'review-2',
          project: 'acme/widgets',
          kind: 'review',
          prompt: null,
          pid: 5,
          log_path: '/tmp/review-2.log',
          status: 'done',
          exit_code: 0,
          started_at: 230,
          finished_at: 240,
          seen: true,
          session_id: 'review-session',
          verdict: 'LGTM',
          parent_job_id: 'fix-1',
        },
      ],
      total: 5,
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderJobsPage()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith(undefined, { limit: 200 })
      expect(container.textContent).toContain('Release pipeline')
      expect(container.textContent).toContain('done')
      expect(container.textContent).not.toContain('completed through review')
    })

    unmount()
  })

  it('expands resumed release steps in latest-activity order', async () => {
    fetchJobsMock.mockResolvedValue({
      jobs: [
        {
          id: 'release-1',
          project: 'acme/widgets',
          kind: 'release',
          prompt: null,
          pid: 1,
          log_path: '/tmp/release-1.log',
          status: 'done',
          exit_code: 0,
          started_at: 100,
          finished_at: 250,
          seen: true,
        },
        {
          id: 'test-1',
          project: 'acme/widgets',
          kind: 'test',
          prompt: null,
          pid: 2,
          log_path: '/tmp/test-1.log',
          status: 'done',
          exit_code: 0,
          started_at: 110,
          finished_at: 120,
          seen: true,
          parent_job_id: 'release-1',
        },
        {
          id: 'review-1',
          project: 'acme/widgets',
          kind: 'review',
          prompt: null,
          pid: 3,
          log_path: '/tmp/review-1.log',
          status: 'done',
          exit_code: 0,
          started_at: 130,
          finished_at: 140,
          seen: true,
          session_id: 'review-session',
          verdict: 'NEEDS ATTENTION',
          parent_job_id: 'test-1',
        },
        {
          id: 'fix-1',
          project: 'acme/widgets',
          kind: 'fix',
          prompt: null,
          pid: 4,
          log_path: '/tmp/fix-1.log',
          status: 'done',
          exit_code: 0,
          started_at: 180,
          finished_at: 200,
          seen: true,
          parent_job_id: 'review-1',
        },
        {
          id: 'review-2',
          project: 'acme/widgets',
          kind: 'review',
          prompt: null,
          pid: 5,
          log_path: '/tmp/review-2.log',
          status: 'done',
          exit_code: 0,
          started_at: 230,
          finished_at: 240,
          seen: true,
          session_id: 'review-session',
          verdict: 'LGTM',
          parent_job_id: 'fix-1',
        },
      ],
      total: 5,
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderJobsPage()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith(undefined, { limit: 200 })
      expect(container.textContent).toContain('Release pipeline')
    })

    const expandButton = Array.from(container.querySelectorAll('button')).find((node) => node.getAttribute('title') === 'Expand steps')
    if (!(expandButton instanceof HTMLButtonElement)) throw new Error('expand button not found')
    expandButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      const text = container.textContent ?? ''
      const testIndex = text.indexOf('Test run')
      const fixIndex = text.indexOf('Auto-fix')
      const reviewIndex = text.lastIndexOf('Code review')
      expect(testIndex).toBeGreaterThanOrEqual(0)
      expect(fixIndex).toBeGreaterThan(testIndex)
      expect(reviewIndex).toBeGreaterThan(fixIndex)
    })

    unmount()
  })
})
