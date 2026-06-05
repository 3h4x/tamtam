import { test, expect } from '@playwright/test'
import type { BrowserContext, Page, Route } from '@playwright/test'

const PROJECT = 'run-dual-surface-mocked'
const SESSION_ID = 'run-dual-surface-session-1'
const PREVIOUS_JOB_ID = 'run-dual-surface-prev-1'
const CURRENT_JOB_ID = 'run-dual-surface-current-1'

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
    user_prompt: 'Earlier checkpoint for the same run session.',
    prompt: 'Earlier checkpoint for the same run session.',
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
    user_prompt: 'Continue the final pass across both UI surfaces.',
    prompt: 'Continue the final pass across both UI surfaces.',
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

function jobsForProject(
  phase: 'running' | 'success' | 'failure',
): Array<ReturnType<typeof previousSessionJob> | ReturnType<typeof runningSessionJob> | ReturnType<typeof finishedSessionJob>> {
  if (phase === 'running') {
    return [previousSessionJob(), runningSessionJob()]
  }
  if (phase === 'success') {
    return [previousSessionJob(), finishedSessionJob(0)]
  }
  return [previousSessionJob(), finishedSessionJob(2, 'Mock provider failed after the final pass')]
}

async function stubSharedRoutes(
  context: BrowserContext,
  jobs: () => ReturnType<typeof jobsForProject>,
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
    (route: Route) =>
      route.fulfill({
        json: {
          jobs: jobs(),
          total: jobs().length,
          pendingReleaseProjects: [],
        },
      }),
  )
  await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const current = jobs()
      const running = current.filter((job) => job.status === 'running').length
      const done = current.filter((job) => job.status === 'done').length
      const failed = current.filter((job) => typeof job.exit_code === 'number' && job.exit_code !== 0).length
      route.fulfill({
        json: {
          total: current.length,
          byKind: { run: current.length },
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

test.describe('Mocked ordinary run dual-surface lifecycle', () => {
  test('history and terminal both show a live run, then settle to success without reload', async ({
    page,
  }) => {
    let phase: 'running' | 'success' | 'failure' = 'running'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubSharedRoutes(page.context(), () => jobsForProject(phase))
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
              ...finishedSessionJob(0),
              log: 'Final streamed output finished successfully.\n',
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
          'data: Final streamed output finished successfully.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            sessionId: SESSION_ID,
            provider: 'claude',
            duration: 1200,
          })}`,
          '',
        ].join('\n'),
      })
    })

    const { historyPage, terminalPage } = await openDualSurfacePages(page)

    const runRow = historyPage.getByRole('button')
      .filter({ hasText: 'Streaming on the terminal while history polls.' })
      .first()

    await expect(runRow).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(historyPage.getByText('1 running')).toBeVisible({ timeout: 8_000 })

    await expect(terminalPage.getByText('Earlier terminal output is restored.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('Continue the final pass across both UI surfaces.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 8_000 })

    const stableHistoryUrl = historyPage.url()
    const stableTerminalUrl = terminalPage.url()

    phase = 'success'
    finishStream()

    await expect(
      terminalPage.getByText('Final streamed output finished successfully.'),
    ).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(terminalPage).toHaveURL(stableTerminalUrl)

    await expect(runRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(historyPage).toHaveURL(stableHistoryUrl)
  })

  test('history clears its spinner when the run fails and terminal shows the provider detail', async ({
    page,
  }) => {
    let phase: 'running' | 'success' | 'failure' = 'running'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubSharedRoutes(page.context(), () => jobsForProject(phase))
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
              ...finishedSessionJob(2, 'Mock provider failed after the final pass'),
              log: 'Final streamed output failed before the session settled.\n',
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
          'data: Final streamed output failed before the session settled.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 2,
            sessionId: SESSION_ID,
            provider: 'claude',
            detail: 'Mock provider failed after the final pass',
            duration: 900,
          })}`,
          '',
        ].join('\n'),
      })
    })

    const { historyPage, terminalPage } = await openDualSurfacePages(page)

    const runRow = historyPage.getByRole('button')
      .filter({ hasText: 'Streaming on the terminal while history polls.' })
      .first()

    await expect(runRow).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 8_000 })

    phase = 'failure'
    finishStream()

    await expect(
      terminalPage.getByText('Final streamed output failed before the session settled.'),
    ).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByText('Mock provider failed after the final pass')).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 8_000 })

    await expect(runRow.getByText('exit 2').first()).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
  })
})
