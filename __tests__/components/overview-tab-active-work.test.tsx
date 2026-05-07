/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { OverviewTab } from '@/components/project-detail/OverviewTab'
import type { JobInfo, ProjectConfig } from '@/lib/client-api'

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('@/components/AgentsTab', () => ({
  AgentsTab: () => <div data-testid="agents-tab" />,
}))

vi.mock('@/components/project-detail/StatusStrip', () => ({
  StatusStrip: () => <div data-testid="status-strip" />,
}))

vi.mock('@/lib/shared/format', () => ({
  formatAgo: (ts: number) => `ago:${ts}`,
}))

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
    status: 'running',
    exit_code: null,
    started_at,
    finished_at: null,
    seen: true,
    ...overrides,
  }
}

function buildConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    project: 'acme/widgets',
    test_command: 'pnpm test',
    detected_test_command: 'pnpm test',
    effective_test_command: 'pnpm test',
    test_cron_enabled: false,
    test_cron_schedule: '0 * * * *',
    auto_commit_enabled: false,
    auto_push_enabled: false,
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

function renderOverview(runningJobs: JobInfo[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(
      React.createElement(OverviewTab, {
        projectName: 'acme/widgets',
        totalChanges: 0,
        unpushed: 0,
        hasUnreviewed: false,
        verdict: undefined,
        isReviewRunning: false,
        latestReview: undefined,
        isTestRunning: false,
        latestTest: undefined,
        ciStatus: null,
        ciFailedUrl: null,
        releaseTag: null,
        aggregateCi: null,
        config: buildConfig(),
        currentBranch: 'master',
        runningJobs,
        projectJobs: runningJobs,
        jobsLoaded: true,
        onOpenChanges: vi.fn(),
      }),
    )
  })

  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

describe('OverviewTab active work', () => {
  beforeEach(() => {
    pushMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('uses the shared run taxonomy for active chips and visible badges', () => {
    const runningJobs = [
      buildJob({ id: 'run-1', kind: 'run', started_at: 100, prompt: 'Investigate flaky tests' }),
      buildJob({ id: 'agent-1', kind: 'agent:cto', started_at: 101 }),
      buildJob({ id: 'fix-ci-1', kind: 'fix-ci', started_at: 102 }),
      buildJob({ id: 'dod-1', kind: 'mark-dod', started_at: 103, context_meta: JSON.stringify({ total: 3, verified: 2 }) }),
      buildJob({ id: 'action-1', kind: 'custom-action', started_at: 104 }),
    ]

    const { container, unmount } = renderOverview(runningJobs)

    expect(container.textContent).toContain('chat 1')
    expect(container.textContent).toContain('agent 1')
    expect(container.textContent).toContain('fix-ci 1')
    expect(container.textContent).toContain('dod 1')
    expect(container.textContent).toContain('action 1')

    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.some((button) => button.textContent?.includes('chat'))).toBe(true)
    expect(buttons.some((button) => button.textContent?.includes('cto'))).toBe(true)
    expect(buttons.some((button) => button.textContent?.includes('Fix CI'))).toBe(true)
    expect(buttons.some((button) => button.textContent?.includes('Mark DoD'))).toBe(true)
    expect(buttons.some((button) => button.textContent?.includes('pipeline'))).toBe(false)
    expect(buttons.some((button) => button.textContent?.includes('other'))).toBe(false)
    expect(container.textContent).toContain('+1 more running job')

    unmount()
  })

  it('labels visible custom actions as action instead of other', () => {
    const { container, unmount } = renderOverview([
      buildJob({ id: 'action-1', kind: 'custom-action', started_at: 104 }),
    ])

    expect(container.textContent).toContain('action 1')
    expect(container.textContent).toContain('custom-action')
    expect(container.textContent).not.toContain('other 1')

    unmount()
  })
})
