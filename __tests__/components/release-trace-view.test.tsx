/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ReleaseTraceView } from '@/components/ReleaseTraceView'

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
    onClick,
  }: React.PropsWithChildren<{
    href: string
    className?: string
    onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void
  }>) => (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  ),
}))

function makeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const { ok = true, status = 200 } = init
  return {
    ok,
    status,
    json: async () => body,
  }
}

function makeTrace(overrides: Record<string, unknown> = {}) {
  return {
    release_id: 'rel-123456789abc',
    project: 'alpha',
    branch: 'feature/release',
    status: 'running',
    started_at: 100,
    finished_at: null,
    exit_code: null,
    trigger: {
      job_id: 'run-1',
      kind: 'run',
      label: 'run',
      prompt: 'Ship the patch',
      started_at: 99,
      finished_at: 99,
      exit_code: 0,
    },
    steps: [
      {
        job_id: 'test-1',
        kind: 'test',
        status: 'done',
        exit_code: 0,
        started_at: 101,
        finished_at: 105,
        duration_ms: 4000,
        verdict: null,
        log_excerpt: 'tests passed',
      },
    ],
    ...overrides,
  }
}

function renderView(props: React.ComponentProps<typeof ReleaseTraceView>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(ReleaseTraceView, props))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('ReleaseTraceView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders the board link and stops polling after the release finishes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({
        settings: {
          github_board_sync_enabled: 'true',
          github_board_view_url: 'https://github.com/orgs/acme/projects/9/views/1',
        },
      }))
      .mockResolvedValueOnce(makeResponse(makeTrace()))
      .mockResolvedValueOnce(makeResponse(makeTrace({
        status: 'done',
        finished_at: 110,
        exit_code: 0,
      })))

    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderView({
      projectName: 'alpha',
      releaseId: 'rel-123456789abc',
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('running')
      expect(container.textContent).toContain('Board')
    })

    const boardLink = Array.from(container.querySelectorAll('a')).find((node) => node.textContent?.includes('Board'))
    expect(boardLink?.getAttribute('href')).toBe(
      'https://github.com/orgs/acme/projects/9/views/1?filterQuery=rel-123456789abc'
    )

    await vi.advanceTimersByTimeAsync(4000)
    await vi.waitFor(() => {
      expect(container.textContent).toContain('success')
    })

    const releaseCallsAfterFinish = fetchMock.mock.calls.filter(([input]) =>
      typeof input === 'string' && input.includes('/api/projects/by-project/alpha/release/rel-123456789abc')
    ).length
    expect(releaseCallsAfterFinish).toBe(2)

    await vi.advanceTimersByTimeAsync(12000)

    const finalReleaseCalls = fetchMock.mock.calls.filter(([input]) =>
      typeof input === 'string' && input.includes('/api/projects/by-project/alpha/release/rel-123456789abc')
    ).length
    expect(finalReleaseCalls).toBe(2)

    unmount()
  })

  it('shows step excerpts and the empty-log fallback when rows are expanded', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input === '/api/settings') {
        return makeResponse({ settings: {} })
      }
      return makeResponse(makeTrace({
        status: 'done',
        finished_at: 110,
        exit_code: 0,
        steps: [
          {
            job_id: 'review-1',
            kind: 'review',
            status: 'done',
            exit_code: 0,
            started_at: 106,
            finished_at: 108,
            duration_ms: 2000,
            verdict: 'LGTM',
            log_excerpt: 'review passed cleanly',
          },
          {
            job_id: 'push-1',
            kind: 'push',
            status: 'done',
            exit_code: 0,
            started_at: 108,
            finished_at: 110,
            duration_ms: 2000,
            verdict: null,
            log_excerpt: '',
          },
        ],
      }))
    }))

    const { container, unmount } = renderView({
      projectName: 'alpha',
      releaseId: 'rel-123456789abc',
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('review')
      expect(container.textContent).toContain('push')
    })

    const reviewButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes('review'))
    if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('review button not found')
    reviewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('review passed cleanly')
    })

    const pushButton = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes('push'))
    if (!(pushButton instanceof HTMLButtonElement)) throw new Error('push button not found')
    pushButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('no log excerpt available')
    })

    unmount()
  })

  it('renders a not-found error when the release trace endpoint returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input === '/api/settings') {
        return makeResponse({ settings: {} })
      }
      return makeResponse({}, { ok: false, status: 404 })
    }))

    const { container, unmount } = renderView({
      projectName: 'alpha',
      releaseId: 'missing-release',
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Release not found')
      expect(container.textContent).toContain('Release id')
      expect(container.textContent).toContain('sing-release')
    })

    unmount()
  })

  it('does not render the board link when board sync is enabled but both URLs are blank', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input === '/api/settings') {
        return makeResponse({
          settings: {
            github_board_sync_enabled: 'true',
            github_board_view_url: '',
            github_board_project_url: '   ',
          },
        })
      }
      return makeResponse(makeTrace({
        status: 'done',
        finished_at: 110,
        exit_code: 0,
      }))
    }))

    const { container, unmount } = renderView({
      projectName: 'alpha',
      releaseId: 'rel-123456789abc',
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('success')
    })

    expect(container.textContent).not.toContain('Board')

    unmount()
  })
})
