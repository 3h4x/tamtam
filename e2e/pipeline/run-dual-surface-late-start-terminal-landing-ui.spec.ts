import { test, expect } from '@playwright/test'
import type { BrowserContext, Route } from '@playwright/test'

import {
  PROJECT,
  RUN_JOB_ID,
  RUN_SESSION_ID,
  finishedTerminalRunJob,
  runningTerminalRunJob,
  now,
} from './terminal-mocked-lifecycle-ui-fixtures'

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

async function stubSharedRoutes(
  context: BrowserContext,
  jobsForProject: () => Array<ReturnType<typeof runningTerminalRunJob> | ReturnType<typeof finishedTerminalRunJob>>,
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
    route.fulfill({ json: { notifications: [] } }),
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
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await context.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: { jobs: jobsForProject(), pendingReleaseProjects: [] },
      }),
  )
  await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const jobs = jobsForProject()
      const running = jobs.filter((job) => job.status === 'running').length
      const done = jobs.filter((job) => job.status === 'done').length
      const failed = jobs.filter(
        (job) => typeof job.exit_code === 'number' && job.exit_code !== 0,
      ).length
      route.fulfill({
        json: {
          total: jobs.length,
          byKind: { run: jobs.length },
          byStatus: { running, done, aborted: 0, failed },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      })
    },
  )
}

test.describe('Mocked ordinary run late-start lifecycle from idle history and terminal landing pages', () => {
  test('both surfaces detect a newly-started run and settle to success without reload', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runFinished = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubSharedRoutes(page.context(), () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return runFinished
        ? [finishedTerminalRunJob(0, 'Late-start dual-surface success output.')]
        : [runningTerminalRunJob()]
    })
    await page.context().route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runFinished
          ? finishedTerminalRunJob(0, 'Late-start dual-surface success output.')
          : runningTerminalRunJob(),
      }),
    )
    await page.context().route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Late-start dual-surface success output.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: 0, sessionId: RUN_SESSION_ID, provider: 'claude', duration: 900 })}`,
          '',
        ].join('\n'),
      })
    })

    const terminalPage = await page.context().newPage()
    await Promise.all([
      page.goto(`/project/${PROJECT}/history`),
      terminalPage.goto(`/project/${PROJECT}/terminal`),
    ])

    await expect(page.getByText('No runs yet').first()).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)

    const runRow = page.getByRole('button').filter({
      hasText: 'Keep the landing page idle.',
    }).first()
    await expect(runRow).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('No runs yet')).toHaveCount(0, { timeout: 12_000 })

    await expect(terminalPage).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({
      timeout: 12_000,
    })
    await expect(terminalPage.getByText('Keep the landing page idle.')).toBeVisible({
      timeout: 12_000,
    })

    runFinished = true
    finishStream()

    await expect(runRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(
      terminalPage.getByText('Late-start dual-surface success output.'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByText('exit 0 — ok').first()).toBeVisible({
      timeout: 12_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 12_000 })
    await expect(terminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    })
  })

  test('both surfaces detect a newly-started run and settle to failure detail without reload', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runFinished = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })
    const failureDetail = 'Provider connection reset after retry budget exhausted.'

    await stubSharedRoutes(page.context(), () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return runFinished
        ? [finishedTerminalRunJob(2, 'Late-start dual-surface failure output.', failureDetail)]
        : [runningTerminalRunJob()]
    })
    await page.context().route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runFinished
          ? finishedTerminalRunJob(2, 'Late-start dual-surface failure output.', failureDetail)
          : runningTerminalRunJob(),
      }),
    )
    await page.context().route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Late-start dual-surface failure output.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: 2, sessionId: RUN_SESSION_ID, provider: 'claude', detail: failureDetail, duration: 600 })}`,
          '',
        ].join('\n'),
      })
    })

    const terminalPage = await page.context().newPage()
    await Promise.all([
      page.goto(`/project/${PROJECT}/history`),
      terminalPage.goto(`/project/${PROJECT}/terminal`),
    ])

    await expect(page.getByText('No runs yet').first()).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)

    const runRow = page.getByRole('button').filter({
      hasText: 'Keep the landing page idle.',
    }).first()
    await expect(runRow).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })

    await expect(terminalPage).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({
      timeout: 12_000,
    })

    runFinished = true
    finishStream()

    await expect(runRow.getByText('exit 2').first()).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByText(failureDetail)).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })

    await expect(
      terminalPage.getByText('Late-start dual-surface failure output.'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByText('exit 2').first()).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByText(failureDetail)).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 12_000 })
    await expect(terminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    })
  })

  test('both surfaces detect a newly-started run and settle to cancelled without reload', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runFinished = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubSharedRoutes(page.context(), () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return runFinished
        ? [finishedTerminalRunJob(-3, 'Late-start dual-surface run was cancelled.')]
        : [runningTerminalRunJob()]
    })
    await page.context().route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runFinished
          ? finishedTerminalRunJob(-3, 'Late-start dual-surface run was cancelled.')
          : runningTerminalRunJob(),
      }),
    )
    await page.context().route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Late-start dual-surface run was cancelled.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: -3, sessionId: RUN_SESSION_ID, provider: 'claude', duration: 450 })}`,
          '',
        ].join('\n'),
      })
    })

    const terminalPage = await page.context().newPage()
    await Promise.all([
      page.goto(`/project/${PROJECT}/history`),
      terminalPage.goto(`/project/${PROJECT}/terminal`),
    ])

    await expect(page.getByText('No runs yet').first()).toBeVisible({ timeout: 8_000 })
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)

    const runRow = page.getByRole('button').filter({
      hasText: 'Keep the landing page idle.',
    }).first()
    await expect(runRow).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('No runs yet')).toHaveCount(0, { timeout: 12_000 })

    await expect(terminalPage).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({
      timeout: 12_000,
    })
    await expect(terminalPage.getByText('Keep the landing page idle.')).toBeVisible({
      timeout: 12_000,
    })

    runFinished = true
    finishStream()

    await expect(runRow.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 12_000,
    })
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })

    await expect(
      terminalPage.getByText('Late-start dual-surface run was cancelled.'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(terminalPage.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 12_000,
    })
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 12_000 })
    await expect(terminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    })
  })
})
