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

vi.mock('@/components/project-detail/PipelineStrip', () => ({
  PipelineStrip: () => <div data-testid="pipeline-strip" />,
}))

vi.mock('@/components/project-detail/PipelineStatsPanel', () => ({
  PipelineStatsPanel: ({ projectName }: { projectName: string }) => <div data-testid="pipeline-stats">{projectName}</div>,
}))

vi.mock('@/components/project-detail/AgentsStats', () => ({
  AgentsStats: ({ projectName }: { projectName: string }) => <div data-testid="agents-stats">{projectName}</div>,
}))

vi.mock('@/components/project-detail/PromptInsightsPanel', () => ({
  PromptInsightsPanel: () => <div data-testid="prompt-insights" />,
}))

// The below-the-fold stats panels mount via useDeferredMount (requestIdleCallback,
// setTimeout fallback). Run the idle callback synchronously so the deferred panels
// appear once their effect flushes, without waiting on the 300ms timeout fallback.
type IdleWindow = {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

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
    issue_auto_branch: true,
    tests_disabled: false,
    review_disabled: false,
    last_push_error: null,
    last_push_at: null,
    ...overrides,
  }
}

function renderOverview(runningJobs: JobInfo[], runningParentLookup?: Map<string, JobInfo>) {
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
        runningReview: undefined,
        isTestRunning: false,
        latestTest: undefined,
        runningTest: undefined,
        ciStatus: null,
        ciFailedUrl: null,
        releaseTag: null,
        aggregateCi: null,
        config: buildConfig(),
        projectJobs: runningJobs,
        runningJobs,
        runningParentLookup,
        jobsLoaded: true,
        jobsPaused: false,
        onOpenChanges: vi.fn(),
        onRefresh: vi.fn(async () => {}),
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
    ;(window as unknown as IdleWindow).requestIdleCallback = (cb) => { cb(); return 1 }
    ;(window as unknown as IdleWindow).cancelIdleCallback = () => {}
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as unknown as IdleWindow).requestIdleCallback
    delete (window as unknown as IdleWindow).cancelIdleCallback
  })

  it('uses the shared run taxonomy for active chips and visible badges', async () => {
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
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="pipeline-stats"]')?.textContent).toBe('acme/widgets')
      expect(container.querySelector('[data-testid="agents-stats"]')?.textContent).toBe('acme/widgets')
    })

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

  it('renders a running release as its originating agent when parent is known', () => {
    // Mirrors the screenshot: a release is running, but instead of showing
    // "Release pipeline" as a separate step, the active-work card surfaces
    // the agent that kicked it off — keeping run + pipeline visually merged.
    const agent = buildJob({
      id: 'agent-improve',
      kind: 'agent:improve',
      started_at: 800,
      prompt: 'Improve dashboard UX',
      user_prompt: 'Improve dashboard UX',
      status: 'done',
      finished_at: 850,
    })
    const release = buildJob({
      id: 'release-1',
      kind: 'release',
      started_at: 900,
      parent_job_id: agent.id,
    })
    const lookup = new Map<string, JobInfo>([[release.id, agent]])

    const { container, unmount } = renderOverview([release], lookup)

    // Card shows the agent's identity, not the generic "Release pipeline".
    expect(container.textContent).toContain('improve')
    expect(container.textContent).not.toContain('Release pipeline')
    expect(container.textContent).toContain('release in progress')

    unmount()
  })

  it('falls back to "Release pipeline" when no parent agent is reachable', () => {
    const release = buildJob({
      id: 'manual-release',
      kind: 'release',
      started_at: 900,
      parent_job_id: null,
    })

    const { container, unmount } = renderOverview([release])

    // No parent in the lookup → original behavior preserved.
    expect(container.textContent).toContain('Release pipeline')
    expect(container.textContent).not.toContain('release in progress')

    unmount()
  })
})
