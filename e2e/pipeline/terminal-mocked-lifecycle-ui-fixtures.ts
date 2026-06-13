import type { Page, Route } from '@playwright/test'

export const PROJECT = 'terminal-mocked-lifecycle'
export const JOB_ID = 'mock-review-live-1'
export const SESSION_ID = 'mock-session-live-1'
export const RELEASE_JOB_ID = 'mock-release-live-1'
export const RELEASE_JOB_ID_OLDER = 'mock-release-live-older'
export const RELEASE_JOB_ID_NEWER = 'mock-release-live-newer'
export const RUN_JOB_ID = 'mock-run-live-1'
export const RUN_SESSION_ID = 'mock-run-session-live-1'

export const now = () => Math.floor(Date.now() / 1000)

function makeTask() {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${PROJECT}`,
    fires_at: '',
    sync: true,
    changes: 0,
    unpushed: 0,
    reviewed: true,
    last_run: null,
    last_run_ago: null,
    last_run_duration_s: null,
    last_run_exit: null,
    release_tag: null,
    ci: null,
    ci_failed_url: null,
    github: null,
  }
}

function makeProjectConfig() {
  return {
    project: PROJECT,
    test_command: '',
    release_timeout_minutes: null,
    detected_test_command: '',
    effective_test_command: '',
    test_cron_enabled: false,
    test_cron_schedule: '',
    auto_push_enabled: false,
    auto_commit_enabled: false,
    auto_pr_merge_enabled: false,
    pr_workflow_enabled: false,
    release_after_run: false,
    tests_disabled: true,
    review_disabled: false,
    issue_auto_branch: false,
    website: '',
    qa_url: '',
  }
}

export function runningJob() {
  return {
    id: JOB_ID,
    project: PROJECT,
    kind: 'review',
    status: 'running',
    exit_code: null,
    started_at: now() - 5,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: SESSION_ID,
    user_prompt: 'Review the mocked terminal lifecycle.',
    prompt: 'Review the mocked terminal lifecycle.',
    context_meta: null,
    provider: 'claude',
    work_summary: null,
  }
}

export function finishedJob(exitCode: number, output: string, detail?: string) {
  return {
    ...runningJob(),
    status: 'done',
    exit_code: exitCode,
    finished_at: now() - 1,
    log: output,
    ...(detail ? { detail } : {}),
  }
}

export function runningReleaseJob(overrides: Partial<{
  id: string
  started_at: number
  work_summary: string
  release_id: string
}> = {}) {
  return {
    id: RELEASE_JOB_ID,
    project: PROJECT,
    kind: 'release',
    status: 'running',
    exit_code: null,
    started_at: now() - 5,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    user_prompt: null,
    prompt: null,
    context_meta: null,
    provider: 'claude',
    work_summary: 'Review is running in the release pipeline.',
    release_id: RELEASE_JOB_ID,
    ...overrides,
  }
}

export function finishedReleaseJob(
  exitCode: number,
  output: string,
  detail?: string,
  overrides: Partial<ReturnType<typeof runningReleaseJob>> = {},
) {
  return {
    ...runningReleaseJob(overrides),
    status: 'done',
    exit_code: exitCode,
    finished_at: now() - 1,
    log: output,
    ...(detail ? { detail } : {}),
  }
}

export function finishedReleaseChildJob(
  overrides: Partial<{
    id: string
    kind: string
    status: 'done' | 'running' | 'aborted'
    exit_code: number | null
    started_at: number
    finished_at: number | null
    session_id: string | null
    work_summary: string | null
  }> = {},
) {
  return {
    id: 'mock-release-child-1',
    project: PROJECT,
    kind: 'fix',
    status: 'done',
    exit_code: 1,
    started_at: now() - 3,
    finished_at: now() - 1,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: 'mock-release-child-session-1',
    parent_job_id: RELEASE_JOB_ID,
    context_meta: null,
    provider: 'claude',
    work_summary: 'Release child failed.',
    ...overrides,
  }
}

export function runningTerminalRunJob() {
  return {
    id: RUN_JOB_ID,
    project: PROJECT,
    kind: 'run',
    status: 'running',
    exit_code: null,
    started_at: now() - 5,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: RUN_SESSION_ID,
    user_prompt: 'Keep the landing page idle.',
    prompt: 'Keep the landing page idle.',
    context_meta: null,
    provider: 'claude',
    work_summary: 'A separate terminal run started elsewhere.',
  }
}

export function finishedTerminalRunJob(exitCode: number, output: string, detail?: string) {
  return {
    ...runningTerminalRunJob(),
    status: 'done',
    exit_code: exitCode,
    finished_at: now() - 1,
    log: output,
    ...(detail ? { detail } : {}),
  }
}

export async function stubProjectShell(
  page: Page,
  jobsForProject: () => unknown[] = () => [runningJob()],
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask()], priorities: [], issueCounts: {} },
    }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  )
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  )
  await page.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') === '1',
    (route: Route) =>
      route.fulfill({
        json: {
          repo: '',
          prCount: 0,
          issueCount: 0,
          openPrBranches: [],
          error: null,
          cached: false,
          cachedAt: now(),
        },
      }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: { jobs: jobsForProject(), pendingReleaseProjects: [] },
      }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const jobs = jobsForProject() as Array<{ kind?: string; status?: string; exit_code?: number | null }>
      const byKind = jobs.reduce<Record<string, number>>((acc, job) => {
        const kind = job.kind ?? 'unknown'
        acc[kind] = (acc[kind] ?? 0) + 1
        return acc
      }, {})
      const running = jobs.filter((job) => job.status === 'running').length
      const done = jobs.filter((job) => job.status === 'done').length
      const failed = jobs.filter(
        (job) => typeof job.exit_code === 'number' && job.exit_code !== 0,
      ).length
      route.fulfill({
        json: {
          total: jobs.length,
          byKind,
          byStatus: { running, done, aborted: 0, failed },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      })
    },
  )
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
}
