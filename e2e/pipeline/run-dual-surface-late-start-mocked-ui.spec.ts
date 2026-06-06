import { test, expect } from '@playwright/test'
import type { BrowserContext, Page, Route } from '@playwright/test'

const PROJECT = 'run-dual-surface-late-start-mocked'
const SESSION_ID = 'run-dual-surface-late-start-session-1'
const PREVIOUS_JOB_ID = 'run-dual-surface-late-start-prev-1'
const CURRENT_JOB_ID = 'run-dual-surface-late-start-current-1'
const PREVIOUS_RUN_PROMPT = 'Earlier checkpoint for the same run session.'
const CURRENT_RUN_PROMPT = 'Continue the late-start run across both UI surfaces.'

const now = () => Math.floor(Date.now() / 1000)

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

function previousSessionJob() {
  return {
    id: PREVIOUS_JOB_ID,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: 0,
    started_at: now() - 120,
    finished_at: now() - 90,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: SESSION_ID,
    user_prompt: PREVIOUS_RUN_PROMPT,
    prompt: PREVIOUS_RUN_PROMPT,
    context_meta: null,
    provider: 'claude',
    work_summary: null,
  }
}

function runningSessionJob() {
  return {
    id: CURRENT_JOB_ID,
    project: PROJECT,
    kind: 'run',
    status: 'running',
    exit_code: null,
    started_at: now() - 30,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: SESSION_ID,
    user_prompt: CURRENT_RUN_PROMPT,
    prompt: CURRENT_RUN_PROMPT,
    context_meta: null,
    provider: 'claude',
    work_summary: 'Streaming on the terminal while history polls.',
  }
}

function finishedSessionJob(exitCode: number, detail?: string) {
  return {
    ...runningSessionJob(),
    status: 'done',
    exit_code: exitCode,
    finished_at: now() - 1,
    ...(detail ? { detail } : {}),
  }
}

async function stubSharedRoutes(
  context: BrowserContext,
  jobs: () => Array<ReturnType<typeof previousSessionJob> | ReturnType<typeof runningSessionJob> | ReturnType<typeof finishedSessionJob>>,
): Promise<void> {
  await context.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask()], priorities: [], issueCounts: {} },
    }),
  )
  await context.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await context.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  )
  await context.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  )
  await context.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await context.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  )
  await context.route(
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
  await context.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') !== '1',
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  )
  await context.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await context.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const currentJobs = jobs()
      route.fulfill({
        json: {
          jobs: currentJobs,
          total: currentJobs.length,
          pendingReleaseProjects: [],
        },
      })
    },
  )
  await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const currentJobs = jobs()
      const running = currentJobs.filter((job) => job.status === 'running').length
      const done = currentJobs.filter((job) => job.status === 'done').length
      const failed = currentJobs.filter(
        (job) => typeof job.exit_code === 'number' && job.exit_code !== 0,
      ).length
      route.fulfill({
        json: {
          total: currentJobs.length,
          byKind: { run: currentJobs.length },
          byStatus: { running, done, aborted: 0, failed },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      })
    },
  )
}

async function openDualSurfacePages(page: Page) {
  const terminalPage = await page.context().newPage()
  await Promise.all([
    page.goto(`/project/${PROJECT}/history`),
    terminalPage.goto(`/project/${PROJECT}/terminal/${SESSION_ID}`),
  ])
  return { historyPage: page, terminalPage }
}

test.describe('Mocked ordinary run late-start dual-surface lifecycle', () => {
  test('history and terminal both pick up a late-start same-session run, then settle to failure without reload', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'failure' = 'idle'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubSharedRoutes(page.context(), () => {
      if (phase === 'idle') return [previousSessionJob()]
      if (phase === 'running') return [previousSessionJob(), runningSessionJob()]
      return [previousSessionJob(), finishedSessionJob(2, 'Mock provider failed after the late start')]
    })
    await page.context().route(`**/api/jobs/${PREVIOUS_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: {
          ...previousSessionJob(),
          log: 'Earlier terminal output is restored.\n',
        },
      }),
    )
    await page.context().route(`**/api/jobs/${CURRENT_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: phase === 'running'
          ? runningSessionJob()
          : {
              ...finishedSessionJob(2, 'Mock provider failed after the late start'),
              log: 'Final streamed output failed after the late start.\n',
            },
      }),
    )
    await page.context().route(`**/api/streaming/${CURRENT_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Final streamed output failed after the late start.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 2,
            sessionId: SESSION_ID,
            provider: 'claude',
            detail: 'Mock provider failed after the late start',
            duration: 900,
          })}`,
          '',
        ].join('\n'),
      })
    })

    const { historyPage, terminalPage } = await openDualSurfacePages(page)

    const runRow = historyPage.getByRole('button')
      .filter({ hasText: PREVIOUS_RUN_PROMPT })
      .first()

    await expect(runRow).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByLabel('running')).toHaveCount(0)
    await expect(historyPage.getByText('1 running')).toHaveCount(0)
    await expect(terminalPage.getByText('Earlier terminal output is restored.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0)

    phase = 'running'

    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(historyPage.getByText('1 running')).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByText(CURRENT_RUN_PROMPT)).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 })

    phase = 'failure'
    finishStream()

    await expect(
      terminalPage.getByText('Final streamed output failed after the late start.'),
    ).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByText('Mock provider failed after the late start')).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 8_000 })

    await expect(runRow.getByText('exit 2').first()).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByText('Mock provider failed after the late start')).toBeVisible({
      timeout: 12_000,
    })
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(historyPage.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
  })

  test('history and terminal both pick up a late-start same-session run, then settle to cancelled without reload', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'cancelled' = 'idle'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubSharedRoutes(page.context(), () => {
      if (phase === 'idle') return [previousSessionJob()]
      if (phase === 'running') return [previousSessionJob(), runningSessionJob()]
      return [previousSessionJob(), finishedSessionJob(-2)]
    })
    await page.context().route(`**/api/jobs/${PREVIOUS_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: {
          ...previousSessionJob(),
          log: 'Earlier terminal output is restored.\n',
        },
      }),
    )
    await page.context().route(`**/api/jobs/${CURRENT_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: phase === 'running'
          ? runningSessionJob()
          : {
              ...finishedSessionJob(-2),
              log: 'Final streamed output stopped after the late start.\n',
            },
      }),
    )
    await page.context().route(`**/api/streaming/${CURRENT_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Final streamed output stopped after the late start.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: -2,
            sessionId: SESSION_ID,
            provider: 'claude',
            duration: 700,
          })}`,
          '',
        ].join('\n'),
      })
    })

    const { historyPage, terminalPage } = await openDualSurfacePages(page)

    const runRow = historyPage.getByRole('button')
      .filter({ hasText: PREVIOUS_RUN_PROMPT })
      .first()

    await expect(runRow).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByLabel('running')).toHaveCount(0)
    await expect(historyPage.getByText('1 running')).toHaveCount(0)
    await expect(terminalPage.getByText('Earlier terminal output is restored.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0)

    phase = 'running'

    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(historyPage.getByText('1 running')).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByText(CURRENT_RUN_PROMPT)).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 })

    phase = 'cancelled'
    finishStream()

    await expect(
      terminalPage.getByText('Final streamed output stopped after the late start.'),
    ).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 8_000 })

    await expect(runRow.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 12_000,
    })
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(historyPage.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
  })
})
