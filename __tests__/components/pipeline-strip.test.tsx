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
    pr_workflow_enabled: false,
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
    totalChanges: 2,
    unpushed: 0,
    hasUnreviewed: false,
    verdict: undefined,
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

  it('marks review, fix, and commit as skipped on the short-circuit push path', () => {
    const { container, unmount } = renderStrip({
      totalChanges: 0,
      unpushed: 0,
      projectJobs: [
        buildJob({ id: 'test-1', kind: 'test', started_at: 100, finished_at: 110 }),
        buildJob({ id: 'push-1', kind: 'push', started_at: 120, status: 'running', finished_at: null, exit_code: null }),
      ],
    })

    expect(container.querySelector('[aria-label^="review: skipped."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="fix: skipped."]')).not.toBeNull()
    expect(container.querySelector('[aria-label^="commit: skipped."]')).not.toBeNull()
    expect(container.textContent).toContain('push')
    expect(container.textContent).toContain('running')
    unmount()
  })

  it('opens the running fix session from the review chip after a NEEDS ATTENTION verdict', () => {
    const { container, unmount } = renderStrip({
      projectJobs: [
        buildJob({ id: 'review-1', kind: 'review', started_at: 100, verdict: 'NEEDS ATTENTION', session_id: 'review-session' }),
        buildJob({ id: 'fix-1', kind: 'fix', started_at: 120, status: 'running', finished_at: null, exit_code: null, session_id: 'fix-session' }),
      ],
    })

    const reviewButton = container.querySelector('[aria-label^="review: running."]')
    if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('review button not found')

    reviewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(pushMock).toHaveBeenCalledWith('/project/acme/widgets/terminal/fix-session')
    unmount()
  })

  it('retries a failed push from the retry button and opens the new push job', async () => {
    pushProjectMock.mockResolvedValue({ job_id: 'push-2' })

    const { container, unmount } = renderStrip({
      unpushed: 1,
      config: buildConfig({ auto_pr_merge_enabled: true }),
      projectJobs: [
        buildJob({ id: 'review-1', kind: 'review', started_at: 100, verdict: 'LGTM', session_id: 'review-session' }),
        buildJob({ id: 'push-1', kind: 'push', started_at: 150, exit_code: 1, finished_at: 160 }),
        buildJob({ id: 'dod-1', kind: 'mark-dod', started_at: 200, status: 'running', finished_at: null, exit_code: null }),
      ],
    })

    const retryButton = container.querySelector('button[title="Retry push"]')
    if (!(retryButton instanceof HTMLButtonElement)) throw new Error('retry button not found')

    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => {
      expect(pushProjectMock).toHaveBeenCalledWith('acme/widgets')
      expect(pushMock).toHaveBeenCalledWith('/project/acme/widgets/terminal?job=push-2')
    })

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
