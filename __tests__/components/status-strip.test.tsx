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

    expect(openMock).toHaveBeenCalledWith('https://github.com/acme/widgets/actions/runs/1', '_blank', 'noopener,noreferrer')
    unmount()
  })

  it('renders skeleton placeholders in isLoading state', () => {
    const { container, unmount } = renderStatusStrip({ isLoading: true })
    // 4 skeleton cards (Changes, Review, Tests, CI), each with two skeleton blocks.
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(8)
    // No interactive buttons when loading.
    expect(container.querySelectorAll('button').length).toBe(0)
    expect(container.textContent).toContain('Changes')
    expect(container.textContent).toContain('Review')
    expect(container.textContent).toContain('Tests')
    expect(container.textContent).toContain('CI')
    unmount()
  })

  it('shows "clean" Changes card when totalChanges is 0', () => {
    const { container, unmount } = renderStatusStrip({ totalChanges: 0 })
    expect(container.textContent).toContain('clean')
    expect(container.textContent).toContain('no uncommitted edits')
    unmount()
  })

  it('renders NEEDS ATTENTION and DO NOT SHIP verdicts with the right text', () => {
    // NEEDS ATTENTION variant
    let result = renderStatusStrip({
      verdict: 'NEEDS ATTENTION',
      latestReview: buildJob({ id: 'r2', started_at: 100, finished_at: 120, verdict: 'NEEDS ATTENTION' }),
    })
    expect(result.container.textContent).toContain('NEEDS ATTENTION')
    result.unmount()

    // DO NOT SHIP variant
    result = renderStatusStrip({
      verdict: 'DO NOT SHIP',
      latestReview: buildJob({ id: 'r3', started_at: 100, finished_at: 120, verdict: 'DO NOT SHIP' }),
    })
    expect(result.container.textContent).toContain('DO NOT SHIP')
    result.unmount()
  })

  it('renders Tests card with pass/fail/not-run-yet states', () => {
    // Passed
    let result = renderStatusStrip({
      latestTest: buildJob({ id: 't1', started_at: 100, finished_at: 130, exit_code: 0, kind: 'test' }),
    })
    expect(result.container.textContent).toContain('Passed')
    result.unmount()

    // Failed with exit code in label
    result = renderStatusStrip({
      latestTest: buildJob({ id: 't2', started_at: 100, finished_at: 130, exit_code: 1, kind: 'test' }),
    })
    expect(result.container.textContent).toContain('Failed (exit 1)')
    result.unmount()

    // Not run yet, with a cron schedule annotation
    result = renderStatusStrip({ testCronSchedule: '15m' })
    expect(result.container.textContent).toContain('not run yet')
    expect(result.container.textContent).toContain('scheduled every 15m')
    result.unmount()
  })

  it('shows the Push card only when unpushed > 0', () => {
    // No push card when 0 unpushed.
    let result = renderStatusStrip({ unpushed: 0 })
    expect(result.container.textContent).not.toContain('ahead')
    result.unmount()

    // Push card with singular form.
    result = renderStatusStrip({ unpushed: 1 })
    expect(result.container.textContent).toContain('1 commit ahead')
    result.unmount()

    // Push card with plural form.
    result = renderStatusStrip({ unpushed: 5 })
    expect(result.container.textContent).toContain('5 commits ahead')
    result.unmount()
  })

  it('shows CI passing / in_progress / no-status branches', () => {
    let result = renderStatusStrip({ ciStatus: 'success', releaseTag: 'v1.2.3' })
    expect(result.container.textContent).toContain('passing')
    expect(result.container.textContent).toContain('release v1.2.3')
    result.unmount()

    result = renderStatusStrip({ ciStatus: 'in_progress' })
    expect(result.container.textContent).toContain('running')
    result.unmount()

    result = renderStatusStrip({ ciStatus: null })
    expect(result.container.textContent).toContain('no status')
    result.unmount()
  })
})
