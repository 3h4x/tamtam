/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { StatusStrip } from '@/components/project-detail/StatusStrip'
import type { JobInfo } from '@/lib/client-api'

vi.mock('@/lib/shared/format', () => ({
  formatAgo: (ts: number) => `ago:${ts}`,
}))

function buildJob(overrides: Partial<JobInfo> & { id: string; started_at: number }): JobInfo {
  const { id, started_at, ...rest } = overrides

  return {
    id,
    project: 'acme/widgets',
    kind: 'review',
    prompt: null,
    pid: 99999,
    log_path: '/tmp/job.log',
    status: 'done',
    exit_code: 0,
    started_at,
    finished_at: started_at + 30,
    seen: true,
    ...rest,
  }
}

function renderStatusStrip(overrides: Partial<React.ComponentProps<typeof StatusStrip>> = {}) {
  const onOpenChanges = vi.fn()
  const onOpenJob = vi.fn()
  const props: React.ComponentProps<typeof StatusStrip> = {
    projectName: 'acme/widgets',
    totalChanges: 0,
    unpushed: 0,
    hasUnreviewed: false,
    verdict: undefined,
    isReviewRunning: false,
    latestReview: undefined,
    isTestRunning: false,
    latestTest: undefined,
    testCronSchedule: null,
    ciStatus: null,
    ciFailedUrl: null,
    releaseTag: null,
    onOpenChanges,
    onOpenJob,
    ...overrides,
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(StatusStrip, props))
  })

  return {
    container,
    onOpenChanges,
    onOpenJob,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('StatusStrip', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('shows awaiting-push detail after an LGTM when there are still local changes', () => {
    const latestReview = buildJob({
      id: 'review-1',
      started_at: 100,
      finished_at: 130,
      verdict: 'LGTM',
    })
    const { container, onOpenJob, unmount } = renderStatusStrip({
      totalChanges: 2,
      verdict: 'LGTM',
      latestReview,
    })

    expect(container.textContent).toContain('LGTM')
    expect(container.textContent).toContain('ago:130 · awaiting push')

    const reviewButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('LGTM'))
    reviewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onOpenJob).toHaveBeenCalledWith('review-1')

    unmount()
  })

  it('shows the starting badge for a running review before a job id exists', () => {
    const { container, unmount } = renderStatusStrip({
      isReviewRunning: true,
    })

    expect(container.textContent).toContain('Review')
    expect(container.textContent).toContain('running')
    expect(container.textContent).toContain('starting')
    const reviewButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Review'))
    expect(reviewButton?.textContent).toContain('running')

    unmount()
  })

  it('opens the failing CI run in a new window when a GitHub URL is present', () => {
    const openMock = vi.fn()
    vi.stubGlobal('window', { ...window, open: openMock })

    const { container, unmount } = renderStatusStrip({
      ciStatus: 'failure',
      ciFailedUrl: 'https://github.com/acme/widgets/actions/runs/1',
    })

    const ciButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('failing'))
    ciButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(openMock).toHaveBeenCalledWith('https://github.com/acme/widgets/actions/runs/1', '_blank')
    unmount()
  })
})
