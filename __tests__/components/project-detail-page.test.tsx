/* @vitest-environment jsdom */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ProjectDetailPage } from '@/components/ProjectDetailPage'
import type { FleetHealth } from '@/hooks/useProjectHealth'
import type { CustomAction, JobInfo, ProjectConfig } from '@/lib/client-api'
import { dispatchJobsPausedChanged } from '@/lib/shared/jobs-paused-events'
import type { Task } from '@/lib/shared/types'

const {
  paramsState,
  pushMock,
  replaceMock,
  toastMock,
  fetchJobsMock,
  fetchProjectConfigMock,
  updateProjectConfigMock,
  fetchCustomActionsMock,
  saveCustomActionsMock,
  runCustomActionMock,
  pullProjectMock,
  fetchBehindMock,
  fetchIssuesAndPRsMock,
  fetchIssuesSummaryMock,
  fetchBranchMock,
  tabNavPropsMock,
  terminalTabPropsMock,
  issuesTabPropsMock,
  changesTabPropsMock,
  historyTabPropsMock,
  overviewTabPropsMock,
} = vi.hoisted(() => ({
  paramsState: {
    name: 'acme/widgets',
    tab: undefined as string | undefined,
    sessionId: undefined as string | undefined,
  },
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  toastMock: vi.fn(),
  fetchJobsMock: vi.fn(),
  fetchProjectConfigMock: vi.fn(),
  updateProjectConfigMock: vi.fn(),
  fetchCustomActionsMock: vi.fn(),
  saveCustomActionsMock: vi.fn(),
  runCustomActionMock: vi.fn(),
  pullProjectMock: vi.fn(),
  fetchBehindMock: vi.fn(),
  fetchIssuesAndPRsMock: vi.fn(),
  fetchIssuesSummaryMock: vi.fn(),
  fetchBranchMock: vi.fn(),
  tabNavPropsMock: vi.fn(),
  terminalTabPropsMock: vi.fn(),
  issuesTabPropsMock: vi.fn(),
  changesTabPropsMock: vi.fn(),
  historyTabPropsMock: vi.fn(),
  overviewTabPropsMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => paramsState,
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}))

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/lib/client-api', () => ({
  fixCi: vi.fn(),
  releaseProject: vi.fn(),
  // Delegate to global fetch so tests that stub `/api/settings` responses
  // (stale-resolve, board-url) keep controlling the settings payload.
  fetchSettings: vi.fn(() => fetch('/api/settings').then((r: Response) => r.json())),
  fetchJobs: fetchJobsMock,
  fetchProjectConfig: fetchProjectConfigMock,
  updateProjectConfig: updateProjectConfigMock,
  fetchCustomActions: fetchCustomActionsMock,
  runCustomAction: runCustomActionMock,
  saveCustomActions: saveCustomActionsMock,
  pullProject: pullProjectMock,
  fetchBehind: fetchBehindMock,
  PullDivergedError: class PullDivergedError extends Error {},
  testProject: vi.fn(),
  fetchIssuesAndPRs: fetchIssuesAndPRsMock,
  fetchIssuesSummary: fetchIssuesSummaryMock,
  pushProject: vi.fn(),
  fetchBranch: fetchBranchMock,
  createProjectPR: vi.fn(),
}))

vi.mock('@/components/TerminalTab', () => ({
  TerminalTab: (props: { projectName: string; initialSessionId?: string }) => {
    terminalTabPropsMock(props)
    return <div data-testid="terminal-tab">{props.initialSessionId ?? 'no-session'}</div>
  },
}))

vi.mock('@/components/ProjectRunsTab', () => ({
  ProjectRunsTab: ({ projectName, jobsPaused }: { projectName: string; jobsPaused?: boolean }) => {
    historyTabPropsMock({ projectName, jobsPaused })
    return <div data-testid="history-tab" data-jobs-paused={jobsPaused ? 'true' : 'false'}>{projectName}</div>
  },
}))

vi.mock('@/components/ChangesTab', () => ({
  ChangesTab: ({ projectName, jobsPaused }: { projectName: string; jobsPaused?: boolean }) => {
    changesTabPropsMock({ projectName, jobsPaused })
    return <div data-testid="changes-tab" data-jobs-paused={jobsPaused ? 'true' : 'false'}>{projectName}</div>
  },
}))

vi.mock('@/components/IssuesTab', () => ({
  IssuesTab: ({ projectName, jobsPaused }: { projectName: string; jobsPaused?: boolean }) => {
    issuesTabPropsMock({ projectName, jobsPaused })
    return <div data-testid="issues-tab" data-jobs-paused={jobsPaused ? 'true' : 'false'}>{projectName}</div>
  },
}))

vi.mock('@/components/DocsTab', () => ({
  DocsTab: ({ projectName }: { projectName: string }) => <div data-testid="docs-tab">{projectName}</div>,
}))

vi.mock('@/components/project-detail/ConfigTab', () => ({
  ConfigTab: (props: {
    config: ProjectConfig | null
    configLoading: boolean
    anyDirty: boolean
    setTestCommandInput: (value: string) => void
    setReleaseTimeoutMinutesInput: (value: string) => void
    setEditActions: (value: CustomAction[]) => void
    onSaveAll: () => Promise<void>
  }) => (
    <div data-testid="config-tab">
      <div data-loading={props.configLoading ? 'loading' : 'ready'} />
      <div data-command={props.config?.test_command ?? 'none'} />
      <div data-dirty={props.anyDirty ? 'yes' : 'no'} />
      <button type="button" onClick={() => props.setTestCommandInput('pnpm lint')}>change config</button>
      <button type="button" onClick={() => props.setReleaseTimeoutMinutesInput('45')}>change timeout</button>
      <button type="button" onClick={() => props.setEditActions([{ name: 'Deploy', command: 'pnpm deploy --prod' }])}>change actions</button>
      <button type="button" onClick={() => void props.onSaveAll()}>save all</button>
    </div>
  ),
}))

vi.mock('@/components/project-detail/ProjectActions', () => ({
  ProjectActions: (props: { jobsPaused: boolean; onCustomAction: (name: string) => Promise<void> }) => (
    <div>
      <button type="button" onClick={() => void props.onCustomAction('Deploy')}>run custom action</button>
      <div
        data-testid="project-actions"
        data-jobs-paused={props.jobsPaused ? 'true' : 'false'}
      />
    </div>
  ),
}))

vi.mock('@/components/project-detail/TabNav', () => ({
  TabNav: (props: { activeTab: string }) => {
    tabNavPropsMock(props)
    return <div data-testid="tab-nav">{props.activeTab}</div>
  },
}))

vi.mock('@/components/project-detail/OverviewTab', () => ({
  OverviewTab: (props: {
    projectName: string
    latestReview?: JobInfo
    latestTest?: JobInfo
    verdict?: string
  }) => {
    overviewTabPropsMock(props)
    return <div data-testid="overview-tab">{props.projectName}</div>
  },
}))

function buildConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    project: 'acme/widgets',
    test_command: 'pnpm test',
    release_timeout_minutes: null,
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
    review_prerequisite_command: '',
    last_push_error: null,
    last_push_at: null,
    ...overrides,
  }
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project: 'acme/widgets',
    job: null,
    priority: null,
    paused: false,
    path: '/tmp/acme-widgets',
    fires_at: '',
    sync: true,
    changes: 2,
    unpushed: 1,
    reviewed: true,
    last_run: null,
    last_run_ago: null,
    last_run_duration_s: null,
    last_run_exit: null,
    release_tag: null,
    ci: null,
    ci_failed_url: null,
    github: null,
    ...overrides,
  }
}

function buildJob(overrides: Partial<JobInfo>): JobInfo {
  return {
    id: 'job-1',
    project: 'acme/widgets',
    kind: 'test',
    prompt: null,
    pid: 0,
    log_path: '/tmp/job.log',
    status: 'done',
    exit_code: 0,
    started_at: 1000,
    finished_at: 2000,
    seen: false,
    ...overrides,
  }
}

function buildFleet(tasks: Task[] = []): FleetHealth {
  return {
    projects: [{
      project: 'acme/widgets',
      status: 'healthy',
      tasks: tasks.map(task => ({
        task,
        status: 'healthy',
        summary: task.project,
      })),
      totalChanges: 2,
      unpushed: 1,
      unreviewedCount: 0,
      lastRunAgo: null,
    }],
    errorCount: 0,
    warningCount: 0,
    healthyCount: 1,
    unknownCount: 0,
    totalTasks: 0,
    totalChanges: 2,
    totalUnreviewed: 0,
  }
}

function renderPage(fleet: FleetHealth = buildFleet()) {
  const onRefresh = vi.fn().mockResolvedValue(undefined)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  flushSync(() => {
    root.render(React.createElement(ProjectDetailPage, {
      fleet,
      onRefresh,
    }))
  })

  return {
    container,
    onRefresh,
    rerender: (nextFleet: FleetHealth) => {
      flushSync(() => {
        root.render(React.createElement(ProjectDetailPage, {
          fleet: nextFleet,
          onRefresh,
        }))
      })
    },
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return button
}

describe('ProjectDetailPage', () => {
  beforeEach(() => {
    paramsState.name = 'acme/widgets'
    paramsState.tab = undefined
    paramsState.sessionId = undefined

    pushMock.mockReset()
    replaceMock.mockReset()
    toastMock.mockReset()
    fetchJobsMock.mockReset()
    fetchProjectConfigMock.mockReset()
    updateProjectConfigMock.mockReset()
    fetchCustomActionsMock.mockReset()
    saveCustomActionsMock.mockReset()
    runCustomActionMock.mockReset()
    pullProjectMock.mockReset()
    fetchBehindMock.mockReset()
    fetchIssuesAndPRsMock.mockReset()
    fetchIssuesSummaryMock.mockReset()
    fetchBranchMock.mockReset()
    tabNavPropsMock.mockReset()
    terminalTabPropsMock.mockReset()
    issuesTabPropsMock.mockReset()
    changesTabPropsMock.mockReset()
    historyTabPropsMock.mockReset()
    overviewTabPropsMock.mockReset()
    fetchJobsMock.mockResolvedValue({ jobs: [] })
    fetchProjectConfigMock.mockResolvedValue(buildConfig())
    updateProjectConfigMock.mockResolvedValue(buildConfig({ test_command: 'pnpm lint' }))
    fetchCustomActionsMock.mockResolvedValue({ actions: [{ name: 'Deploy', command: 'pnpm deploy' }] })
    saveCustomActionsMock.mockResolvedValue({ actions: [{ name: 'Deploy', command: 'pnpm deploy' }] })
    runCustomActionMock.mockResolvedValue({ job_id: 'job-123' })
    fetchBehindMock.mockResolvedValue({ behind: 0 })
    fetchIssuesAndPRsMock.mockResolvedValue({ prs: [], issues: [] })
    fetchIssuesSummaryMock.mockResolvedValue({ prCount: 0, issueCount: 0, openPrBranches: [], repo: 'owner/repo', error: null, cached: true, cachedAt: 0 })
    fetchBranchMock.mockResolvedValue({ branch: 'master', defaultBranch: 'master', commitsAhead: 0 })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ settings: {} }),
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('forces the terminal tab when a session id is present', async () => {
    paramsState.tab = 'config'
    paramsState.sessionId = 'sess-42'

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(tabNavPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ activeTab: 'terminal' }))
      expect(terminalTabPropsMock).toHaveBeenLastCalledWith({
        projectName: 'acme/widgets',
        initialSessionId: 'sess-42',
      })
      expect(container.querySelector('[data-testid="terminal-tab"]')?.textContent).toBe('sess-42')
    })

    unmount()
  })

  it('falls back to overview when the route targets the removed recommendations tab', async () => {
    paramsState.tab = 'recommendations'

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(tabNavPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ activeTab: 'overview' }))
      expect(container.querySelector('[data-testid="overview-tab"]')?.textContent).toBe('acme/widgets')
    })

    unmount()
  })

  it('routes incomplete project overview visits into setup', async () => {
    fetchProjectConfigMock.mockResolvedValue(buildConfig({ setup_complete: false }))

    const { unmount } = renderPage()

    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/project/acme%2Fwidgets/setup')
    })

    unmount()
  })

  // A non-empty fleet that simply doesn't contain the requested project is the
  // GENUINELY-missing case (typo'd URL, deleted project) → render "not found".
  // An EMPTY fleet means the list hasn't loaded yet → render a loading state
  // (covered by its own test below) — not "not found".
  function fleetMissingTarget(): FleetHealth {
    return {
      ...buildFleet(),
      projects: [{
        project: 'other/repo',
        status: 'healthy',
        tasks: [],
        totalChanges: 0,
        unpushed: 0,
        unreviewedCount: 0,
        lastRunAgo: null,
      }],
      healthyCount: 1,
      totalChanges: 0,
    }
  }

  it('shows a loading state (not "not found") while the projects list is empty', async () => {
    const { container, unmount } = renderPage({
      ...buildFleet(),
      projects: [],
      healthyCount: 0,
      totalChanges: 0,
    })
    // Cold /api/projects can take many seconds; until the list arrives we must
    // NOT claim the project doesn't exist.
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('not found')
    })
    expect(fetchJobsMock).not.toHaveBeenCalled()
    unmount()
  })

  it('does not start project-specific polling when the project is missing', async () => {
    const { container, unmount } = renderPage(fleetMissingTarget())

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Project "acme/widgets" not found.')
    })

    expect(fetchJobsMock).not.toHaveBeenCalled()
    expect(fetchCustomActionsMock).not.toHaveBeenCalled()
    expect(fetchProjectConfigMock).not.toHaveBeenCalled()
    expect(fetchBehindMock).not.toHaveBeenCalled()
    expect(fetchIssuesAndPRsMock).not.toHaveBeenCalled()
    expect(fetchIssuesSummaryMock).not.toHaveBeenCalled()
    expect(fetchBranchMock).not.toHaveBeenCalled()

    unmount()
  })

  it('starts project-specific polling when a missing project appears later', async () => {
    const { container, rerender, unmount } = renderPage(fleetMissingTarget())

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Project "acme/widgets" not found.')
    })
    expect(fetchJobsMock).not.toHaveBeenCalled()

    rerender(buildFleet())

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="overview-tab"]')?.textContent).toBe('acme/widgets')
      expect(fetchJobsMock).toHaveBeenCalledWith('acme/widgets')
      expect(fetchBehindMock).toHaveBeenCalledWith('acme/widgets')
    })

    unmount()
  })

  it('does not auto-pull on mount even when the branch is behind', async () => {
    fetchBehindMock.mockResolvedValue({ behind: 3 })

    const { unmount } = renderPage()

    await vi.waitFor(() => {
      expect(fetchBehindMock).toHaveBeenCalledWith('acme/widgets')
    })
    expect(pullProjectMock).not.toHaveBeenCalled()

    unmount()
  })

  it('picks the latest finished review and test jobs from unsorted polling results', async () => {
    fetchJobsMock.mockResolvedValue({ jobs: [
      buildJob({ id: 'old-review', kind: 'review', verdict: 'LGTM', finished_at: 2000 }),
      buildJob({ id: 'latest-test', kind: 'test', finished_at: 5000 }),
      buildJob({ id: 'latest-review', kind: 'review', verdict: 'NEEDS ATTENTION', finished_at: 4000 }),
      buildJob({ id: 'old-test', kind: 'test', finished_at: 1000 }),
    ] })

    const { unmount } = renderPage()

    await vi.waitFor(() => {
      expect(overviewTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
        latestReview: expect.objectContaining({ id: 'latest-review' }),
        latestTest: expect.objectContaining({ id: 'latest-test' }),
        verdict: 'NEEDS ATTENTION',
      }))
    })

    unmount()
  })

  it('saves both config and custom actions from the config tab', async () => {
    paramsState.tab = 'config'
    fetchProjectConfigMock
      .mockResolvedValueOnce(buildConfig())
      .mockResolvedValueOnce(buildConfig({ test_command: 'pnpm lint' }))

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(fetchProjectConfigMock).toHaveBeenCalledWith('acme/widgets')
      expect(fetchCustomActionsMock).toHaveBeenCalledWith('acme/widgets')
      expect(container.querySelector('[data-testid="config-tab"]')).not.toBeNull()
      expect(container.querySelector('[data-loading="ready"]')).not.toBeNull()
      expect(container.querySelector('[data-command="pnpm test"]')).not.toBeNull()
    })

    flushSync(() => {
      buttonByText(container, 'change config').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      buttonByText(container, 'change timeout').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      buttonByText(container, 'change actions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-dirty="yes"]')).not.toBeNull()
    })

    flushSync(() => {
      buttonByText(container, 'save all').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(updateProjectConfigMock).toHaveBeenCalledWith('acme/widgets', expect.objectContaining({
        test_command: 'pnpm lint',
        release_timeout_minutes: '45',
        test_cron_enabled: false,
        auto_push_enabled: false,
      }))
      expect(saveCustomActionsMock).toHaveBeenCalledWith('acme/widgets', [
        { name: 'Deploy', command: 'pnpm deploy --prod' },
      ])
      expect(fetchProjectConfigMock).toHaveBeenCalledTimes(2)
    })

    unmount()
  })

  it('starts a custom action and opens its terminal job', async () => {
    const { container, unmount } = renderPage()

    flushSync(() => {
      buttonByText(container, 'run custom action').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(runCustomActionMock).toHaveBeenCalledWith('acme/widgets', 'Deploy')
      expect(toastMock).toHaveBeenCalledWith('Deploy started for acme/widgets', 'success')
      expect(pushMock).toHaveBeenCalledWith('/project/acme%2Fwidgets/terminal?job=job-123')
    })

    unmount()
  })

  it('blocks custom actions while jobs are paused on an already open page', async () => {
    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="project-actions"]')?.getAttribute('data-jobs-paused')).toBe('false')
    })

    flushSync(() => {
      dispatchJobsPausedChanged(true)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="project-actions"]')?.getAttribute('data-jobs-paused')).toBe('true')
    })

    flushSync(() => {
      buttonByText(container, 'run custom action').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(runCustomActionMock).not.toHaveBeenCalled()
      expect(toastMock).toHaveBeenCalledWith('Jobs are paused globally. Resume jobs to run this custom action.', 'info')
    })

    unmount()
  })

  it('updates release pause state live without remounting the project page', async () => {
    paramsState.tab = 'issues'
    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="project-actions"]')?.getAttribute('data-jobs-paused')).toBe('false')
      expect(issuesTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: false }))
    })

    flushSync(() => {
      dispatchJobsPausedChanged(true)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="project-actions"]')?.getAttribute('data-jobs-paused')).toBe('true')
      expect(issuesTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: true }))
    })

    flushSync(() => {
      dispatchJobsPausedChanged(false)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="project-actions"]')?.getAttribute('data-jobs-paused')).toBe('false')
      expect(issuesTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: false }))
    })

    unmount()
  })

  it('updates changes-tab push pause state live without remounting the project page', async () => {
    paramsState.tab = 'changes'
    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="changes-tab"]')?.getAttribute('data-jobs-paused')).toBe('false')
      expect(changesTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: false }))
    })

    flushSync(() => {
      dispatchJobsPausedChanged(true)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="changes-tab"]')?.getAttribute('data-jobs-paused')).toBe('true')
      expect(changesTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: true }))
    })

    flushSync(() => {
      dispatchJobsPausedChanged(false)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="changes-tab"]')?.getAttribute('data-jobs-paused')).toBe('false')
      expect(changesTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: false }))
    })

    unmount()
  })

  it('updates history-tab release pause state live without remounting the project page', async () => {
    paramsState.tab = 'history'
    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="history-tab"]')?.getAttribute('data-jobs-paused')).toBe('false')
      expect(historyTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: false }))
    })

    flushSync(() => {
      dispatchJobsPausedChanged(true)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="history-tab"]')?.getAttribute('data-jobs-paused')).toBe('true')
      expect(historyTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: true }))
    })

    flushSync(() => {
      dispatchJobsPausedChanged(false)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="history-tab"]')?.getAttribute('data-jobs-paused')).toBe('false')
      expect(historyTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: false }))
    })

    unmount()
  })

  it('keeps live pause state after a stale settings fetch resolves late', async () => {
    paramsState.tab = 'issues'

    let resolveSettings!: (value: { json: () => Promise<{ settings: { jobs_paused: string } }> }) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      resolveSettings = resolve
    })))

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="project-actions"]')?.getAttribute('data-jobs-paused')).toBe('false')
      expect(issuesTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: false }))
    })

    flushSync(() => {
      dispatchJobsPausedChanged(true)
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="project-actions"]')?.getAttribute('data-jobs-paused')).toBe('true')
      expect(issuesTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: true }))
    })

    resolveSettings({
      json: async () => ({ settings: { jobs_paused: 'false' } }),
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="project-actions"]')?.getAttribute('data-jobs-paused')).toBe('true')
      expect(issuesTabPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ jobsPaused: true }))
    })

    flushSync(() => {
      buttonByText(container, 'run custom action').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(runCustomActionMock).not.toHaveBeenCalled()
      expect(toastMock).toHaveBeenCalledWith('Jobs are paused globally. Resume jobs to run this custom action.', 'info')
    })

    unmount()
  })

  it('clears the board link after a polled settings refresh blanks the board URLs', async () => {
    vi.useFakeTimers()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          settings: {
            github_board_sync_enabled: 'true',
            github_board_view_url: 'https://github.com/orgs/acme/projects/9/views/1',
            github_board_project_url: 'https://github.com/orgs/acme/projects/9',
          },
        }),
      })
      .mockResolvedValue({
        json: async () => ({
          settings: {
            github_board_sync_enabled: 'true',
            github_board_view_url: '',
            github_board_project_url: '   ',
          },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = renderPage()

    await vi.waitFor(() => {
      const boardLink = container.querySelector('a[title="Open this project on the TamTam GitHub board"]')
      expect(boardLink?.getAttribute('href')).toBe('https://github.com/orgs/acme/projects/9/views/1?filterQuery=acme%2Fwidgets')
    })

    await vi.advanceTimersByTimeAsync(5000)

    await vi.waitFor(() => {
      expect(container.querySelector('a[title="Open this project on the TamTam GitHub board"]')).toBeNull()
    })

    unmount()
    vi.useRealTimers()
  })

  it('renders the linked issue badge for slugged issue branches', async () => {
    fetchBranchMock.mockResolvedValue({ branch: 'fix/issue-77-gates', defaultBranch: 'master', commitsAhead: 1 })

    const { container, unmount } = renderPage(buildFleet([
      buildTask({ github: 'https://github.com/acme/widgets' }),
    ]))

    await vi.waitFor(() => {
      const issueLink = container.querySelector('a[title="Open linked GitHub issue #77"]')
      expect(issueLink?.getAttribute('href')).toBe('https://github.com/acme/widgets/issues/77')
      expect(issueLink?.textContent).toContain('#77')
    })

    unmount()
  })

  it('renders the linked issue badge for bare issue branches', async () => {
    fetchBranchMock.mockResolvedValue({ branch: 'fix/issue-99', defaultBranch: 'master', commitsAhead: 0 })

    const { container, unmount } = renderPage(buildFleet([
      buildTask({ github: 'https://github.com/acme/widgets' }),
    ]))

    await vi.waitFor(() => {
      const issueLink = container.querySelector('a[title="Open linked GitHub issue #99"]')
      expect(issueLink?.getAttribute('href')).toBe('https://github.com/acme/widgets/issues/99')
      expect(issueLink?.textContent).toContain('#99')
    })

    unmount()
  })

  it('does not render the linked issue badge for non-issue branches', async () => {
    fetchBranchMock.mockResolvedValue({ branch: 'feature/refactor-header', defaultBranch: 'master', commitsAhead: 0 })

    const { container, unmount } = renderPage(buildFleet([
      buildTask({ github: 'https://github.com/acme/widgets' }),
    ]))

    await vi.waitFor(() => {
      expect(fetchBranchMock).toHaveBeenCalledWith('acme/widgets')
    })
    expect(container.querySelector('a[title^="Open linked GitHub issue #"]')).toBeNull()

    unmount()
  })
})
