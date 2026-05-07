/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { JobsPage } from '@/components/JobsPage'

const { fetchJobsMock, pushMock } = vi.hoisted(() => ({
  fetchJobsMock: vi.fn(),
  pushMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('@/lib/client-api', () => ({
  fetchJobs: fetchJobsMock,
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
      pendingReleaseProjects: [],
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
      expect(fetchJobsMock).toHaveBeenCalledWith(undefined, { limit: 50 })
      expect(container.textContent).toContain('startedago:100')
    })

    expect(container.textContent).not.toContain('live')
    expect(container.textContent).not.toContain('last')
    // started label must appear exactly once (MetaChip only, no duplicate span)
    expect(container.textContent!.split('started').length).toBe(2)
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
      pendingReleaseProjects: [],
    })

    const { container, unmount } = renderJobsPage()

    await vi.waitFor(() => {
      expect(fetchJobsMock).toHaveBeenCalledWith(undefined, { limit: 50 })
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
})
