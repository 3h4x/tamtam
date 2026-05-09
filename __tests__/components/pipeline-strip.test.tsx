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
  default: ({ children, href, className }: React.PropsWithChildren<{ href: string; className?: string }>) => (
    <a href={href} className={className}>{children}</a>
  ),
}))

vi.mock('@/lib/client-api', () => ({
  pushProject: pushProjectMock,
}))

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/lib/shared/format', () => ({
  formatAgo: (ts: number) => `ago:${ts}`,
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

  it('only shows jobs that actually ran on the short-circuit push path', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'test-1', kind: 'test', started_at: 100, finished_at: 110, release_id: 'rel-1' }),
        buildJob({ id: 'push-1', kind: 'push', started_at: 120, status: 'running', finished_at: null, exit_code: null, release_id: 'rel-1' }),
      ],
    })

    // review/fix/commit never ran — they should not appear at all
    expect(container.querySelector('[aria-label^="review:"]')).toBeNull()
    expect(container.querySelector('[aria-label^="fix:"]')).toBeNull()
    expect(container.querySelector('[aria-label^="commit:"]')).toBeNull()
    // test chip is present with label 'test' (not 'run')
    expect(container.querySelector('[aria-label^="test:"]')).not.toBeNull()
    expect(container.textContent).toContain('push')
    expect(container.textContent).toContain('running')
    unmount()
  })

  it('excludes unrelated nearby pipeline jobs that are not linked to the running release', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'manual-test', kind: 'test', started_at: 100, finished_at: 110 }),
        buildJob({ id: 'release-review', kind: 'review', started_at: 120, finished_at: 150, verdict: 'LGTM', release_id: 'rel-2' }),
        buildJob({ id: 'release-push', kind: 'push', started_at: 160, status: 'running', finished_at: null, exit_code: null, release_id: 'rel-2' }),
      ],
    })

    expect(container.querySelector('[aria-label="test: done. tests passed (ago:110) — click to view log"]')).toBeNull()
    expect(container.querySelector('[aria-label^="review: done. LGTM"]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="push:"]')).not.toBeNull()
    unmount()
  })

  it('excludes concurrent standalone pipeline jobs while a release-backed chain is running', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'rel-standalone-filter', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'release-review-running', kind: 'review', started_at: 100, status: 'running', finished_at: null, exit_code: null, release_id: 'rel-standalone-filter' }),
        buildJob({ id: 'manual-test-running', kind: 'test', started_at: 110, status: 'running', finished_at: null, exit_code: null }),
      ],
    })

    expect(container.querySelector('[aria-label^="review: running."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="test: running."]')).toBeNull()
    expect(container.querySelector('a[href="/project/acme%2Fwidgets/release/rel-standalone-filter"]')).not.toBeNull()
    unmount()
  })

  it('renders test chip with label "test" when a test job is running', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'test-run-1', kind: 'test', started_at: 100, status: 'running', finished_at: null, exit_code: null, session_id: 'test-session' }),
      ],
    })

    expect(container.querySelector('[aria-label^="test: running."]')).not.toBeNull()
    expect(container.textContent).toContain('test')
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === 'abort')).toBe(false)
    unmount()
  })

  it('keeps the summary chip non-actionable while removing click CTA copy for running steps', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'review-running-1', kind: 'review', started_at: 100, status: 'running', finished_at: null, exit_code: null, session_id: 'review-running-session' }),
      ],
    })

    const summary = container.querySelector('[aria-label^="pipeline summary:"]')
    if (!(summary instanceof HTMLDivElement)) throw new Error('summary chip not found')
    expect(summary.textContent).not.toContain('click to')
    expect(summary.getAttribute('title')).toBe('review in progress')

    const reviewButton = container.querySelector('[aria-label^="review: running."]')
    if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('review button not found')
    expect(reviewButton.getAttribute('title')).toBe('review in progress — click to open terminal')

    unmount()
  })

  it('shows parent-linked pipeline ancestors when release_id is absent and omits the trace link', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'test-parent', kind: 'test', started_at: 100, finished_at: 110 }),
        buildJob({ id: 'review-parent', kind: 'review', started_at: 120, finished_at: 150, verdict: 'NEEDS ATTENTION', parent_job_id: 'test-parent' }),
        buildJob({ id: 'fix-child', kind: 'fix', started_at: 160, status: 'running', finished_at: null, exit_code: null, parent_job_id: 'review-parent' }),
      ],
    })

    expect(container.querySelector('[aria-label^="test: done."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="review: attention."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="fix: running."]')).not.toBeNull()
    expect(container.querySelector('a[title="View unified release trace"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === 'abort')).toBe(false)
    unmount()
  })

  it('shows review as attention and fix as running independently after a NEEDS ATTENTION verdict', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'review-1', kind: 'review', started_at: 100, verdict: 'NEEDS ATTENTION', session_id: 'review-session', release_id: 'rel-3' }),
        buildJob({ id: 'fix-1', kind: 'fix', started_at: 120, status: 'running', finished_at: null, exit_code: null, session_id: 'fix-session', release_id: 'rel-3' }),
      ],
    })

    // review chip shows as attention (NEEDS ATTENTION verdict), opens the review session
    const reviewButton = container.querySelector('[aria-label^="review: attention."]')
    if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('review button not found')
    reviewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushMock).toHaveBeenCalledWith('/project/acme/widgets/terminal/review-session')

    pushMock.mockReset()

    // fix chip shows as running, opens the fix session
    const fixButton = container.querySelector('[aria-label^="fix: running."]')
    if (!(fixButton instanceof HTMLButtonElement)) throw new Error('fix button not found')
    fixButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushMock).toHaveBeenCalledWith('/project/acme/widgets/terminal/fix-session')

    unmount()
  })

  it('keeps the summary chip non-actionable while removing click CTA copy for attention states', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'release-attention-root', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'review-attention-1', kind: 'review', started_at: 100, verdict: 'NEEDS ATTENTION', session_id: 'review-attention-session', release_id: 'release-attention-root' }),
      ],
    })

    const summary = container.querySelector('[aria-label^="pipeline summary:"]')
    if (!(summary instanceof HTMLDivElement)) throw new Error('summary chip not found')
    expect(summary.textContent).not.toContain('click to')
    expect(summary.getAttribute('title')).toBe('verdict: NEEDS ATTENTION')

    const reviewButton = container.querySelector('[aria-label^="review: attention."]')
    if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('review button not found')
    expect(reviewButton.getAttribute('title')).toBe('verdict: NEEDS ATTENTION — click to view findings')

    unmount()
  })

  it('marks a completed review with no verdict as failed unknown while a linked fix is running', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'review-unknown', kind: 'review', started_at: 100, verdict: undefined, release_id: 'rel-unknown' }),
        buildJob({ id: 'fix-unknown', kind: 'fix', started_at: 120, status: 'running', finished_at: null, exit_code: null, release_id: 'rel-unknown' }),
      ],
    })

    expect(container.querySelector('[aria-label^="review: failed. verdict: unknown"]')).not.toBeNull()
    unmount()
  })

  it('hides the strip after a failed pipeline step when nothing is still running', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'push-failed', kind: 'push', started_at: 100, exit_code: 1, finished_at: 110, release_id: 'rel-failed' }),
      ],
      config: buildConfig({ last_push_error: 'Push failed: remote rejected' }),
      unpushed: 1,
    })

    expect(container.innerHTML).toBe('')
    unmount()
  })

  it('retries a failed push from the retry button and opens the new push job', async () => {
    pushProjectMock.mockResolvedValue({ job_id: 'push-2' })

    const { container, unmount } = renderStrip({
      config: buildConfig({ auto_pr_merge_enabled: true }),
      projectJobs: [
        buildJob({ id: 'review-1', kind: 'review', started_at: 100, verdict: 'LGTM', session_id: 'review-session', release_id: 'rel-4' }),
        buildJob({ id: 'push-1', kind: 'push', started_at: 150, exit_code: 1, finished_at: 160, release_id: 'rel-4' }),
        buildJob({ id: 'dod-1', kind: 'mark-dod', started_at: 200, status: 'running', finished_at: null, exit_code: null, release_id: 'rel-4' }),
      ],
    })

    const retryButton = container.querySelector('button[title="Retry push"]')
    if (!(retryButton instanceof HTMLButtonElement)) throw new Error('retry button not found')

    // Only job-backed steps should render; auto-merge stays hidden until pr-wait actually starts.
    expect(container.querySelector('[aria-label^="merge:"]')).toBeNull()

    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(pushProjectMock).toHaveBeenCalledWith('acme/widgets', { releaseId: 'rel-4' })
      expect(pushMock).toHaveBeenCalledWith('/project/acme/widgets/terminal?job=push-2')
    })

    unmount()
  })

  it('disables failed-push retry while jobs are paused', () => {
    const { container, unmount } = renderStrip({
      jobsPaused: true,
      config: buildConfig({ auto_pr_merge_enabled: true }),
      projectJobs: [
        buildJob({ id: 'review-1', kind: 'review', started_at: 100, verdict: 'LGTM', release_id: 'rel-4' }),
        buildJob({ id: 'push-1', kind: 'push', started_at: 150, exit_code: 1, finished_at: 160, release_id: 'rel-4' }),
        buildJob({ id: 'dod-1', kind: 'mark-dod', started_at: 200, status: 'running', finished_at: null, exit_code: null, release_id: 'rel-4' }),
      ],
    })

    const retryButton = container.querySelector('button[title="Jobs are paused globally. Resume jobs to start a push."]')
    if (!(retryButton instanceof HTMLButtonElement)) throw new Error('retry button not found')
    expect(retryButton.disabled).toBe(true)

    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pushProjectMock).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()

    unmount()
  })

  it('shows merge during pr-wait without a synthetic pre-merge dod step', () => {
    const { container, unmount } = renderStrip({
      config: buildConfig({ auto_pr_merge_enabled: true }),
      projectJobs: [
        buildJob({ id: 'review-merge-1', kind: 'review', started_at: 100, verdict: 'LGTM', release_id: 'rel-merge-1' }),
        buildJob({ id: 'push-merge-1', kind: 'push', started_at: 150, finished_at: 160, release_id: 'rel-merge-1' }),
        buildJob({ id: 'pr-wait-1', kind: 'pr-wait', started_at: 170, status: 'running', finished_at: null, exit_code: null, release_id: 'rel-merge-1' }),
      ],
    })

    expect(container.querySelector('[aria-label^="merge: running."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="dod:"]')).toBeNull()

    unmount()
  })

  it('confirms and aborts the active release pipeline', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ status: 'aborted' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, onRefresh, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'release-1', kind: 'release', started_at: 90, status: 'running', finished_at: null, exit_code: null }),
        buildJob({ id: 'review-1', kind: 'review', started_at: 100, status: 'running', finished_at: null, exit_code: null }),
      ],
    })

    const abortButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'abort')
    if (!(abortButton instanceof HTMLButtonElement)) throw new Error('abort button not found')
    flushSync(() => {
      abortButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const confirmButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'yes')
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
})
