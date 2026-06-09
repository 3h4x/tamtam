/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { PipelineStrip } from '@/components/project-detail/PipelineStrip'
import type { JobInfo, ProjectConfig } from '@/lib/client-api'

const { pushMock, pushProjectMock, toastMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  pushProjectMock: vi.fn(),
  toastMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, className, title }: React.PropsWithChildren<{ href: string; className?: string; title?: string }>) => (
    <a href={href} className={className} title={title}>{children}</a>
  ),
}))

vi.mock('@/lib/client-api', () => ({
  pushProject: pushProjectMock,
}))

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

function buildConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    project: 'acme/widgets',
    test_command: 'pnpm test',
    detected_test_command: 'pnpm test',
    effective_test_command: 'pnpm test',
    test_cron_enabled: false,
    test_cron_schedule: '0 * * * *',
    auto_commit_enabled: true,
    auto_push_enabled: true,
    auto_pr_merge_enabled: false,
    release_after_run: false,
    issue_auto_branch: true,
    tests_disabled: false,
    review_disabled: false,
    last_push_error: null,
    last_push_at: null,
    ...overrides,
  }
}

function buildJob({
  id,
  kind,
  started_at,
  ...overrides
}: Partial<JobInfo> & { id: string; kind: string; started_at: number }): JobInfo {
  return {
    id,
    project: 'acme/widgets',
    kind,
    prompt: null,
    pid: 99999,
    log_path: '/tmp/job.log',
    status: 'done',
    exit_code: 0,
    started_at,
    finished_at: started_at + 30,
    seen: true,
    ...overrides,
  }
}

function renderStrip(overrides: Partial<React.ComponentProps<typeof PipelineStrip>> = {}) {
  const onRefresh = vi.fn().mockResolvedValue(undefined)
  const props: React.ComponentProps<typeof PipelineStrip> = {
    projectName: 'acme/widgets',
    projectJobs: [],
    config: buildConfig(),
    totalChanges: 0,
    unpushed: 0,
    hasUnreviewed: false,
    verdict: undefined,
    jobsPaused: false,
    onRefresh,
    ...overrides,
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(PipelineStrip, props))
  })

  return {
    container,
    onRefresh,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('PipelineStrip', () => {
  beforeEach(() => {
    pushMock.mockReset()
    pushProjectMock.mockReset()
    toastMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders nothing when no pipeline step is running', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'review-1', kind: 'review', started_at: 100, verdict: 'LGTM' }),
      ],
    })

    expect(container.innerHTML).toBe('')
    unmount()
  })

  it('surfaces an active release step with a trace link and abort control', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'aborted' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, onRefresh, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'review-1', kind: 'review', started_at: 100, status: 'running', finished_at: null, exit_code: null, session_id: 'review-session', release_id: 'release-1' }),
      ],
    })

    expect(container.querySelector('[aria-label="pipeline summary: review running"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="review: running."]')).not.toBeNull()
    expect(container.querySelector('a[title="View unified release trace"]')).not.toBeNull()

    const reviewButton = container.querySelector('[aria-label^="review: running."]')
    if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('review button not found')
    reviewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushMock).toHaveBeenCalledWith('/project/acme%2Fwidgets/terminal/review-session')

    const abortButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'abort')
    if (!(abortButton instanceof HTMLButtonElement)) throw new Error('abort button not found')
    flushSync(() => {
      abortButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'yes')
    if (!(confirmButton instanceof HTMLButtonElement)) throw new Error('confirm button not found')
    flushSync(() => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/projects/by-project/acme%2Fwidgets/release/abort', { method: 'POST' })
      expect(toastMock).toHaveBeenCalledWith('Pipeline aborted', 'success')
      expect(onRefresh).toHaveBeenCalled()
    })

    unmount()
  })

  it('allows aborting an active release while jobs are paused', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'aborted' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, onRefresh, unmount } = renderStrip({
      jobsPaused: true,
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'review-1', kind: 'review', started_at: 100, status: 'running', finished_at: null, exit_code: null, session_id: 'review-session', release_id: 'release-1' }),
      ],
    })

    const abortButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'abort')
    if (!(abortButton instanceof HTMLButtonElement)) throw new Error('abort button not found')
    flushSync(() => {
      abortButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'yes')
    if (!(confirmButton instanceof HTMLButtonElement)) throw new Error('confirm button not found')
    expect(confirmButton.disabled).toBe(false)
    flushSync(() => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/projects/by-project/acme%2Fwidgets/release/abort', { method: 'POST' })
      expect(toastMock).toHaveBeenCalledWith('Pipeline aborted', 'success')
      expect(onRefresh).toHaveBeenCalled()
    })

    unmount()
  })

  it('keeps transitive parent-linked release steps visible when child rows omit release_id', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'test-1', kind: 'test', started_at: 100, parent_job_id: 'release-1' }),
        buildJob({ id: 'review-1', kind: 'review', started_at: 130, status: 'running', finished_at: null, exit_code: null, session_id: 'review-session', parent_job_id: 'test-1' }),
      ],
    })

    expect(container.querySelector('[aria-label="pipeline summary: review running"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="test: done."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="review: running."]')).not.toBeNull()
    expect(container.querySelector('a[href="/project/acme%2Fwidgets/release/release-1"]')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'abort')).toBe(true)
    unmount()
  })

  it('does not summarize unrelated standalone jobs while a release is active', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'manual-test', kind: 'test', started_at: 130, status: 'running', finished_at: null, exit_code: null, session_id: 'manual-test-session' }),
      ],
    })

    expect(container.querySelector('[aria-label="pipeline summary: release running"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="pipeline summary: test running"]')).toBeNull()
    expect(container.querySelector('[aria-label^="test: running."]')).toBeNull()
    expect(container.querySelector('a[href="/project/acme%2Fwidgets/release/release-1"]')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'abort')).toBe(true)
    unmount()
  })

  it('renders only the newest job for each step kind during release fix loops', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'test-1', kind: 'test', started_at: 100, release_id: 'release-1' }),
        buildJob({ id: 'review-old', kind: 'review', started_at: 130, verdict: 'NEEDS ATTENTION', session_id: 'review-old-session', release_id: 'release-1' }),
        buildJob({ id: 'fix-1', kind: 'fix', started_at: 160, release_id: 'release-1' }),
        buildJob({ id: 'review-new', kind: 'review', started_at: 190, status: 'running', finished_at: null, exit_code: null, session_id: 'review-new-session', release_id: 'release-1' }),
      ],
    })

    const reviewButtons = container.querySelectorAll('[aria-label^="review:"]')
    expect(reviewButtons).toHaveLength(1)
    expect(container.querySelector('[aria-label="pipeline summary: review running"]')).not.toBeNull()
    // The review→fix loop cycled, so the collapsed review pill surfaces its run count.
    expect(container.querySelector('[aria-label^="review: running, 2 runs."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="review: attention"]')).toBeNull()
    expect(container.textContent).toContain('2/3')

    const reviewButton = reviewButtons[0]
    if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('review button not found')
    reviewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushMock).toHaveBeenCalledWith('/project/acme%2Fwidgets/terminal/review-new-session')

    unmount()
  })

  it('surfaces last push error details and retries a release-linked failed push', async () => {
    pushProjectMock.mockResolvedValue({ status: 'started', job_id: 'push-2' })
    const { container, unmount } = renderStrip({
      config: buildConfig({ last_push_error: 'Push failed: remote rejected: protected branch' }),
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'push-1', kind: 'push', started_at: 130, exit_code: 1, finished_at: 150, release_id: 'release-1' }),
        buildJob({ id: 'fix-1', kind: 'fix', started_at: 160, status: 'running', finished_at: null, exit_code: null, session_id: 'fix-session', release_id: 'release-1' }),
      ],
    })

    expect(container.querySelector('[aria-label="pipeline summary: fix running"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="push: failed. Push failed: remote rejected: protected branch"]')).not.toBeNull()

    const pushButton = container.querySelector('[aria-label^="push: failed."]')
    if (!(pushButton instanceof HTMLButtonElement)) throw new Error('push button not found')
    pushButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushMock).toHaveBeenCalledWith('/project/acme%2Fwidgets/terminal?job=push-1')

    const retryButton = container.querySelector('button[title="Retry push"]')
    if (!(retryButton instanceof HTMLButtonElement)) throw new Error('retry button not found')
    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(pushProjectMock).toHaveBeenCalledWith('acme/widgets', { releaseId: 'release-1' })
      expect(pushMock).toHaveBeenCalledWith('/project/acme%2Fwidgets/terminal?job=push-2')
    })

    unmount()
  })

  it('disables release-linked failed-push retry while jobs are paused', () => {
    const { container, unmount } = renderStrip({
      jobsPaused: true,
      config: buildConfig({ last_push_error: 'Push failed: remote rejected: protected branch' }),
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'push-1', kind: 'push', started_at: 130, exit_code: 1, finished_at: 150, release_id: 'release-1' }),
        buildJob({ id: 'fix-1', kind: 'fix', started_at: 160, status: 'running', finished_at: null, exit_code: null, session_id: 'fix-session', release_id: 'release-1' }),
      ],
    })

    const retryButton = container.querySelector('button[title="Jobs are paused globally. Resume jobs to start a push."]')
    if (!(retryButton instanceof HTMLButtonElement)) throw new Error('paused retry button not found')
    expect(retryButton.disabled).toBe(true)

    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushProjectMock).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalledWith('Jobs are paused globally. Resume jobs to start a push.', 'info')

    unmount()
  })

  it('marks completed review jobs with no verdict as failed unknown', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'review-1', kind: 'review', started_at: 130, verdict: undefined, session_id: 'review-session', release_id: 'release-1' }),
        buildJob({ id: 'fix-1', kind: 'fix', started_at: 160, status: 'running', finished_at: null, exit_code: null, session_id: 'fix-session', release_id: 'release-1' }),
      ],
    })

    expect(container.querySelector('[aria-label="pipeline summary: fix running"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="review: failed. verdict: unknown"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="review: done."]')).toBeNull()

    const reviewButton = container.querySelector('[aria-label^="review: failed."]')
    if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('review button not found')
    reviewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushMock).toHaveBeenCalledWith('/project/acme%2Fwidgets/terminal/review-session')

    unmount()
  })

  it('marks DO NOT SHIP reviews as failed instead of done during active releases', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'test-1', kind: 'test', started_at: 110, release_id: 'release-1' }),
        buildJob({ id: 'review-1', kind: 'review', started_at: 130, verdict: 'DO NOT SHIP', session_id: 'review-session', release_id: 'release-1' }),
        buildJob({ id: 'fix-1', kind: 'fix', started_at: 160, status: 'running', finished_at: null, exit_code: null, session_id: 'fix-session', release_id: 'release-1' }),
      ],
    })

    expect(container.querySelector('[aria-label="pipeline summary: fix running"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="review: failed. verdict: DO NOT SHIP"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="review: done. verdict: DO NOT SHIP"]')).toBeNull()
    expect(container.textContent).toContain('1/3')

    const reviewButton = container.querySelector('[aria-label^="review: failed."]')
    if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('review button not found')
    reviewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushMock).toHaveBeenCalledWith('/project/acme%2Fwidgets/terminal/review-session')

    unmount()
  })

  it('marks completed DoD as attention when verification counts are incomplete', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({
          id: 'dod-1',
          kind: 'mark-dod',
          started_at: 130,
          release_id: 'release-1',
          context_meta: JSON.stringify({ verified: 2, total: 3 }),
        }),
        buildJob({ id: 'merge-1', kind: 'pr-wait', started_at: 160, status: 'running', finished_at: null, exit_code: null, release_id: 'release-1' }),
      ],
    })

    expect(container.querySelector('[aria-label="pipeline summary: merge running"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="dod: attention. DoD: 2 / 3 verified"]')).not.toBeNull()
    expect(container.querySelector('[title="DoD: 2 / 3 verified — 1 unticked — click to view log"]')).not.toBeNull()
    expect(container.textContent).toContain('0/2')

    unmount()
  })

  it('shows standalone running pipeline jobs without release-only controls', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'test-1', kind: 'test', started_at: 100, status: 'running', finished_at: null, exit_code: null }),
      ],
    })

    expect(container.querySelector('[aria-label="pipeline summary: test running"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="test: running."]')).not.toBeNull()
    expect(container.querySelector('a[title="View unified release trace"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'abort')).toBe(false)
    unmount()
  })

  it('keeps standalone parent-linked pipeline ancestors visible without release controls', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'test-1', kind: 'test', started_at: 100 }),
        buildJob({ id: 'review-1', kind: 'review', started_at: 130, verdict: 'NEEDS ATTENTION', parent_job_id: 'test-1' }),
        buildJob({ id: 'fix-1', kind: 'fix', started_at: 160, status: 'running', finished_at: null, exit_code: null, session_id: 'fix-session', parent_job_id: 'review-1' }),
      ],
    })

    expect(container.querySelector('[aria-label="pipeline summary: fix running"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="test: done."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="review: attention."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="fix: running."]')).not.toBeNull()
    expect(container.querySelector('a[title="View unified release trace"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'abort')).toBe(false)
    unmount()
  })
})
