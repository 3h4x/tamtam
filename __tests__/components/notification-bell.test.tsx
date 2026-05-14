/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { NotificationBell } from '@/components/NotificationBell'
import type { JobInfo } from '@/lib/client-api'

const { pushMock, fetchNotificationsMock, markNotificationsSeenMock, markJobSeenMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  fetchNotificationsMock: vi.fn(),
  markNotificationsSeenMock: vi.fn(),
  markJobSeenMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, onClick, className }: React.PropsWithChildren<{ href: string; onClick?: () => void; className?: string }>) => (
    <a href={href} onClick={onClick} className={className}>{children}</a>
  ),
}))

vi.mock('@/lib/client-api', () => ({
  fetchNotifications: fetchNotificationsMock,
  markNotificationsSeen: markNotificationsSeenMock,
  markJobSeen: markJobSeenMock,
}))

function makeJob(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 'job-1',
    project: 'alpha',
    kind: 'review',
    prompt: null,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    started_at: 100,
    finished_at: 160,
    seen: false,
    ...overrides,
  }
}

function renderBell() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(NotificationBell))
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

const FAST_WAIT = { interval: 1, timeout: 1000 } as const

function bellButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button')
  if (!(button instanceof HTMLButtonElement)) throw new Error('bell button not found')
  return button
}

function notificationRow(container: HTMLElement, project: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'))
  const row = buttons.find((button) => button.textContent?.includes(project) && button !== bellButton(container))
  if (!(row instanceof HTMLButtonElement)) throw new Error(`notification row not found for ${project}`)
  return row
}

describe('NotificationBell', () => {
  beforeEach(() => {
    fetchNotificationsMock.mockResolvedValue({
      count: 1,
      jobs: [],
      runningCount: 0,
      runningJobs: [],
    })
    markNotificationsSeenMock.mockResolvedValue(undefined)
    markJobSeenMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    pushMock.mockReset()
    fetchNotificationsMock.mockReset()
    markNotificationsSeenMock.mockReset()
    markJobSeenMock.mockReset()
    document.body.innerHTML = ''
  })

  it('renders NEEDS ATTENTION reviews as attention in the dropdown', async () => {
    fetchNotificationsMock.mockResolvedValue({
      count: 1,
      jobs: [makeJob({ verdict: 'NEEDS ATTENTION' })],
      runningCount: 0,
      runningJobs: [],
    })

    const { container, unmount } = renderBell()

    await vi.waitFor(() => {
      expect(fetchNotificationsMock).toHaveBeenCalled()
      expect(bellButton(container).textContent).toContain('1')
    }, FAST_WAIT)

    bellButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('needs attention')
      expect(container.querySelector('svg[aria-label="attention"]')).not.toBeNull()
      expect(container.querySelector('svg[aria-label="success"]')).toBeNull()
    }, FAST_WAIT)

    unmount()
  })

  it('renders DO NOT SHIP reviews as attention in the dropdown', async () => {
    fetchNotificationsMock.mockResolvedValue({
      count: 1,
      jobs: [makeJob({ verdict: 'DO NOT SHIP' })],
      runningCount: 0,
      runningJobs: [],
    })

    const { container, unmount } = renderBell()

    await vi.waitFor(() => {
      expect(fetchNotificationsMock).toHaveBeenCalled()
    }, FAST_WAIT)

    bellButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('do not ship')
      expect(container.querySelector('svg[aria-label="attention"]')).not.toBeNull()
      expect(container.querySelector('svg[aria-label="success"]')).toBeNull()
    }, FAST_WAIT)

    unmount()
  })

  it('renders missing review verdicts as attention instead of exit 0', async () => {
    fetchNotificationsMock.mockResolvedValue({
      count: 1,
      jobs: [makeJob({ verdict: undefined, exit_code: 0 })],
      runningCount: 0,
      runningJobs: [],
    })

    const { container, unmount } = renderBell()

    await vi.waitFor(() => {
      expect(fetchNotificationsMock).toHaveBeenCalled()
    }, FAST_WAIT)

    bellButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('review verdict missing')
      expect(container.textContent).not.toContain('exit 0')
      expect(container.querySelector('svg[aria-label="attention"]')).not.toBeNull()
    }, FAST_WAIT)

    unmount()
  })

  it('keeps LGTM reviews green in the dropdown', async () => {
    fetchNotificationsMock.mockResolvedValue({
      count: 1,
      jobs: [makeJob({ verdict: 'LGTM' })],
      runningCount: 0,
      runningJobs: [],
    })

    const { container, unmount } = renderBell()

    await vi.waitFor(() => {
      expect(fetchNotificationsMock).toHaveBeenCalled()
    }, FAST_WAIT)

    bellButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('LGTM')
      expect(container.querySelector('svg[aria-label="success"]')).not.toBeNull()
      expect(container.querySelector('svg[aria-label="attention"]')).toBeNull()
    }, FAST_WAIT)

    unmount()
  })

  it('marks aborted finished jobs seen when opened from the dropdown', async () => {
    fetchNotificationsMock.mockResolvedValue({
      count: 1,
      jobs: [makeJob({ id: 'aborted-job', kind: 'release', status: 'aborted', exit_code: -3, project: 'abort-proj' })],
      runningCount: 0,
      runningJobs: [],
    })

    const { container, unmount } = renderBell()

    await vi.waitFor(() => {
      expect(fetchNotificationsMock).toHaveBeenCalled()
    }, FAST_WAIT)

    bellButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(notificationRow(container, 'abort-proj')).toBeInstanceOf(HTMLButtonElement)
    }, FAST_WAIT)

    notificationRow(container, 'abort-proj').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(markJobSeenMock).toHaveBeenCalledWith('aborted-job')
      expect(pushMock).toHaveBeenCalledWith('/project/abort-proj/terminal?job=aborted-job')
    }, FAST_WAIT)

    unmount()
  })

  it.each([
    ['fix', 'fix-ok'],
    ['fix-ci', 'fix-ci-ok'],
    ['fix-push', 'fix-push-ok'],
  ] as const)('keeps an older unseen failure visible over a newer successful %s', async (kind, successId) => {
    fetchNotificationsMock.mockResolvedValue({
      count: 2,
      jobs: [
        makeJob({
          id: 'test-fail',
          project: 'alpha',
          kind: 'test',
          exit_code: 1,
          finished_at: 100,
        }),
        makeJob({
          id: successId,
          project: 'alpha',
          kind,
          exit_code: 0,
          finished_at: 200,
        }),
      ],
      runningCount: 0,
      runningJobs: [],
    })

    const { container, unmount } = renderBell()

    await vi.waitFor(() => {
      expect(fetchNotificationsMock).toHaveBeenCalled()
      expect(bellButton(container).textContent).toContain('1')
    }, FAST_WAIT)

    bellButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('test')
      expect(container.textContent).toContain('exit 1')
      expect(container.textContent).not.toContain(successId)
    }, FAST_WAIT)

    notificationRow(container, 'alpha').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(markJobSeenMock).toHaveBeenCalledWith('test-fail')
      expect(pushMock).toHaveBeenCalledWith('/project/alpha/terminal?job=test-fail')
    }, FAST_WAIT)

    unmount()
  })

  it('collapseFinishedJobs: shows the attention review over a newer LGTM review for the same project', async () => {
    // Two review jobs for the same project: one LGTM (success), one NEEDS ATTENTION.
    // collapseFinishedJobs must pick the attention job regardless of finish order.
    fetchNotificationsMock.mockResolvedValue({
      count: 2,
      jobs: [
        makeJob({
          id: 'review-lgtm',
          project: 'alpha',
          kind: 'review',
          exit_code: 0,
          finished_at: 200,
          verdict: 'LGTM',
        }),
        makeJob({
          id: 'review-needs-attention',
          project: 'alpha',
          kind: 'review',
          exit_code: 0,
          finished_at: 100,
          verdict: 'NEEDS ATTENTION',
        }),
      ],
      runningCount: 0,
      runningJobs: [],
    })

    const { container, unmount } = renderBell()

    await vi.waitFor(() => {
      expect(fetchNotificationsMock).toHaveBeenCalled()
      // Collapsed to one entry despite two jobs from same project
      expect(bellButton(container).textContent).toContain('1')
    }, FAST_WAIT)

    bellButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      // Attention job content is shown
      expect(container.querySelector('svg[aria-label="attention"]')).not.toBeNull()
      expect(container.textContent).toContain('needs attention')
      // LGTM job is not shown
      expect(container.querySelector('svg[aria-label="success"]')).toBeNull()
      expect(container.textContent).not.toContain('review-lgtm')
    }, FAST_WAIT)

    unmount()
  })

  it('keeps an older unseen failure visible over a newer successful mark-dod', async () => {
    fetchNotificationsMock.mockResolvedValue({
      count: 2,
      jobs: [
        makeJob({
          id: 'review-fail',
          project: 'alpha',
          kind: 'review',
          exit_code: 1,
          finished_at: 100,
          verdict: 'NEEDS ATTENTION',
        }),
        makeJob({
          id: 'dod-ok',
          project: 'alpha',
          kind: 'mark-dod',
          exit_code: 0,
          finished_at: 200,
        }),
      ],
      runningCount: 0,
      runningJobs: [],
    })

    const { container, unmount } = renderBell()

    await vi.waitFor(() => {
      expect(fetchNotificationsMock).toHaveBeenCalled()
      expect(bellButton(container).textContent).toContain('1')
    }, FAST_WAIT)

    bellButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(container.textContent).toContain('needs attention')
      expect(container.textContent).not.toContain('dod-ok')
      expect(container.querySelector('svg[aria-label="attention"]')).not.toBeNull()
    }, FAST_WAIT)

    unmount()
  })
})
