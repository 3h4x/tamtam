import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'terminal-mocked-lifecycle'
const JOB_ID = 'mock-review-live-1'
const SESSION_ID = 'mock-session-live-1'
const RELEASE_JOB_ID = 'mock-release-live-1'
const RELEASE_JOB_ID_OLDER = 'mock-release-live-older'
const RELEASE_JOB_ID_NEWER = 'mock-release-live-newer'
const RUN_JOB_ID = 'mock-run-live-1'
const RUN_SESSION_ID = 'mock-run-session-live-1'

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

function runningJob() {
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

function finishedJob(exitCode: number, output: string, detail?: string) {
  return {
    ...runningJob(),
    status: 'done',
    exit_code: exitCode,
    finished_at: now() - 1,
    log: output,
    ...(detail ? { detail } : {}),
  }
}

function runningReleaseJob(overrides: Partial<{
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

function finishedReleaseJob(
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

function finishedReleaseChildJob(
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

function runningTerminalRunJob() {
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

function finishedTerminalRunJob(exitCode: number, output: string, detail?: string) {
  return {
    ...runningTerminalRunJob(),
    status: 'done',
    exit_code: exitCode,
    finished_at: now() - 1,
    log: output,
    ...(detail ? { detail } : {}),
  }
}

async function stubProjectShell(
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

test.describe('Mocked terminal lifecycle UI', () => {
  test('terminal job deep link shows live run, then clears after streamed success', async ({ page }) => {
    let serveRunningJob = true
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningJob ? [runningJob()] : []))
    await page.route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningJob()
          : finishedJob(0, 'Mocked review output reached the terminal.\n'),
      }),
    )
    await page.route(`**/api/streaming/${JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mocked review output reached the terminal.',
          '',
          `event: done`,
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

    await page.goto(`/project/${PROJECT}/terminal?job=${JOB_ID}`)

    await expect(page.getByText('Review the mocked terminal lifecycle.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningJob = false
    finishStream()

    await expect(page.getByText('Mocked review output reached the terminal.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`))
  })

  test('terminal job deep link clears live state and shows stream failure details', async ({ page }) => {
    let serveRunningJob = true
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningJob ? [runningJob()] : []))
    await page.route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningJob()
          : finishedJob(2, 'Mocked review output failed in the terminal.\n', 'Mock provider failed hard'),
      }),
    )
    await page.route(`**/api/streaming/${JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mocked review output failed in the terminal.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: 2,
            sessionId: SESSION_ID,
            provider: 'claude',
            detail: 'Mock provider failed hard',
            duration: 900,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal?job=${JOB_ID}`)

    await expect(page.getByText('Review the mocked terminal lifecycle.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningJob = false
    finishStream()

    await expect(page.getByText('Mocked review output failed in the terminal.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Mock provider failed hard')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`))
  })

  test('terminal job deep link clears live state after streamed cancellation', async ({ page }) => {
    let serveRunningJob = true
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningJob ? [runningJob()] : []))
    await page.route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningJob()
          : finishedJob(-3, 'Mocked review output stopped before completion.\n'),
      }),
    )
    await page.route(`**/api/streaming/${JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mocked review output stopped before completion.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: -3,
            sessionId: SESSION_ID,
            provider: 'claude',
            duration: 700,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal?job=${JOB_ID}`)

    await expect(page.getByText('Review the mocked terminal lifecycle.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningJob = false
    finishStream()

    await expect(page.getByText('Mocked review output stopped before completion.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`))
  })

  test('terminal landing page auto-attaches when a release starts after the page is already open', async ({
    page,
  }) => {
    let serveRunningRelease = false
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningRelease ? [runningReleaseJob()] : []))
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningRelease
          ? runningReleaseJob()
          : finishedReleaseJob(0, 'Release output reached the terminal after auto-attach.\n'),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Release output reached the terminal after auto-attach.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: 0,
            provider: 'claude',
            duration: 1400,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRelease = true

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningRelease = false
    finishStream()

    await expect(
      page.getByText('Release output reached the terminal after auto-attach.'),
    ).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
  })

  test('terminal landing page auto-attaches to a release failure and clears live state', async ({
    page,
  }) => {
    let serveRunningRelease = false
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningRelease ? [runningReleaseJob()] : []))
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningRelease
          ? runningReleaseJob()
          : finishedReleaseJob(2, 'Release output failed after auto-attach.\n', 'Release failed during push after auto-attach'),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Release output failed after auto-attach.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: 2,
            provider: 'claude',
            detail: 'Release failed during push after auto-attach',
            duration: 1400,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRelease = true

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningRelease = false
    finishStream()

    await expect(page.getByText('Release output failed after auto-attach.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Release failed during push after auto-attach')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
  })

  test('terminal landing page auto-attaches to a cancelled release and clears live state', async ({
    page,
  }) => {
    let serveRunningRelease = false
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => (serveRunningRelease ? [runningReleaseJob()] : []))
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningRelease
          ? runningReleaseJob()
          : finishedReleaseJob(-3, 'Release output was cancelled after auto-attach.\n'),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Release output was cancelled after auto-attach.',
          '',
          `event: done`,
          `data: ${JSON.stringify({
            exitCode: -3,
            provider: 'claude',
            duration: 1100,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRelease = true

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    serveRunningRelease = false
    finishStream()

    await expect(page.getByText('Release output was cancelled after auto-attach.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
  })

  test('terminal landing page auto-attaches when an ordinary run starts elsewhere', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return [runningTerminalRunJob()]
    })
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runningTerminalRunJob(),
      }),
    )
    await page.route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Ordinary run output reached the landing page after auto-attach.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            sessionId: RUN_SESSION_ID,
            provider: 'claude',
            duration: 900,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Keep the landing page idle.')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0)

    serveRunningRun = false
    finishStream()

    await expect(
      page.getByText('Ordinary run output reached the landing page after auto-attach.'),
    ).toBeVisible({
      timeout: 8_000,
    })
  })

  test('terminal landing page stays on an attached ordinary run when a release starts later', async ({
    page,
  }) => {
    let phase: 'idle' | 'run-only' | 'run-and-release' = 'idle'
    let runOnlyPolls = 0

    await stubProjectShell(page, () => {
      if (phase === 'run-only') {
        runOnlyPolls += 1
        return [runningTerminalRunJob()]
      }
      if (phase === 'run-and-release') return [runningTerminalRunJob(), runningReleaseJob()]
      return []
    })
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runningReleaseJob(),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({ status: 204, body: '' }),
    )

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    phase = 'run-only'

    await expect.poll(() => runOnlyPolls, { timeout: 4_000 }).toBeGreaterThan(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0)

    phase = 'run-and-release'

    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toHaveCount(0)
  })

  test('terminal landing page auto-attaches to the newest running release when multiple releases are live', async ({
    page,
  }) => {
    const olderRelease = runningReleaseJob({
      id: RELEASE_JOB_ID_OLDER,
      release_id: RELEASE_JOB_ID_OLDER,
      started_at: now() - 20,
      work_summary: 'Older release is still running.',
    })
    const newerRelease = runningReleaseJob({
      id: RELEASE_JOB_ID_NEWER,
      release_id: RELEASE_JOB_ID_NEWER,
      started_at: now() - 3,
      work_summary: 'Newest release should win the auto-attach.',
    })

    await stubProjectShell(page, () => [olderRelease, newerRelease])
    await page.route(`**/api/jobs/${RELEASE_JOB_ID_OLDER}`, (route: Route) =>
      route.fulfill({
        json: olderRelease,
      }),
    )
    await page.route(`**/api/jobs/${RELEASE_JOB_ID_NEWER}`, (route: Route) =>
      route.fulfill({
        json: newerRelease,
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID_NEWER}`, (route: Route) =>
      route.fulfill({ status: 204, body: '' }),
    )

    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID_NEWER)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace').first()).toBeVisible({
      timeout: 8_000,
    })
  })

  test('history list and terminal landing page stay in sync across a mocked release start and finish', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'done' = 'idle'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    const historyPage = await page.context().newPage()
    const jobsForProject = () => {
      if (phase === 'running') return [runningReleaseJob()]
      if (phase === 'done') {
        return [finishedReleaseJob(0, 'Release output reached both surfaces.\n')]
      }
      return []
    }

    await stubProjectShell(page, jobsForProject)
    await stubProjectShell(historyPage, jobsForProject)
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'running'
            ? runningReleaseJob()
            : finishedReleaseJob(0, 'Release output reached both surfaces.\n'),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Release output reached both surfaces.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            provider: 'claude',
            duration: 1500,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await Promise.all([
      page.goto(`/project/${PROJECT}/terminal`),
      historyPage.goto(`/project/${PROJECT}/history`),
    ])

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)
    await expect(historyPage.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })

    phase = 'running'

    const releaseRow = historyPage.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
    await expect(releaseRow).toBeVisible({ timeout: 12_000 })
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTitle('View unified release trace')).toBeVisible({ timeout: 8_000 })

    phase = 'done'
    finishStream()

    await expect(page.getByText('Release output reached both surfaces.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })

    await expect(releaseRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(historyPage.getByText('No runs yet')).toHaveCount(0)
  })

  test('history list and terminal landing page stay in sync across a mocked release failure', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'failed' = 'idle'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    const historyPage = await page.context().newPage()
    const jobsForProject = () => {
      if (phase === 'running') return [runningReleaseJob()]
      if (phase === 'failed') {
        const failedChild = finishedReleaseChildJob({
          id: 'mock-release-push-failed',
          kind: 'fix',
          exit_code: 2,
          work_summary: 'Release failed while both surfaces were open.',
        })
        return [
          finishedReleaseJob(
            2,
            'Release output failed on both surfaces.\n',
            'Release failed while both surfaces were open.',
          ),
          failedChild,
        ]
      }
      return []
    }

    await stubProjectShell(page, jobsForProject)
    await stubProjectShell(historyPage, jobsForProject)
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'running'
            ? runningReleaseJob()
            : finishedReleaseJob(
                2,
                'Release output failed on both surfaces.\n',
                'Release failed while both surfaces were open.',
              ),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Release output failed on both surfaces.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 2,
            provider: 'claude',
            detail: 'Release failed while both surfaces were open.',
            duration: 1500,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await Promise.all([
      page.goto(`/project/${PROJECT}/terminal`),
      historyPage.goto(`/project/${PROJECT}/history`),
    ])

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)
    await expect(historyPage.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })

    phase = 'running'

    const releaseRow = historyPage.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
    await expect(releaseRow).toBeVisible({ timeout: 12_000 })
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })

    phase = 'failed'
    finishStream()

    await expect(page.getByText('Release output failed on both surfaces.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Release failed while both surfaces were open.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })

    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(releaseRow.getByText('release failed', { exact: true })).toBeVisible({
      timeout: 12_000,
    })
    await expect(historyPage.getByText('No runs yet')).toHaveCount(0)
  })

  test('history list and terminal landing page stay in sync across a mocked release cancellation', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'cancelled' = 'idle'
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    const historyPage = await page.context().newPage()
    const jobsForProject = () => {
      if (phase === 'running') return [runningReleaseJob()]
      if (phase === 'cancelled') {
        const cancelledChild = finishedReleaseChildJob({
          id: 'mock-release-review-cancelled',
          kind: 'fix',
          status: 'aborted',
          exit_code: -3,
          work_summary: 'Release output was cancelled on both surfaces.',
        })
        return [
          finishedReleaseJob(
            -3,
            'Release output was cancelled on both surfaces.\n',
            undefined,
            { status: 'aborted' },
          ),
          cancelledChild,
        ]
      }
      return []
    }

    await stubProjectShell(page, jobsForProject)
    await stubProjectShell(historyPage, jobsForProject)
    await page.route(`**/api/jobs/${RELEASE_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'running'
            ? runningReleaseJob()
            : finishedReleaseJob(
                -3,
                'Release output was cancelled on both surfaces.\n',
                undefined,
                { status: 'aborted' },
              ),
      }),
    )
    await page.route(`**/api/streaming/${RELEASE_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Release output was cancelled on both surfaces.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: -3,
            provider: 'claude',
            duration: 1200,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await Promise.all([
      page.goto(`/project/${PROJECT}/terminal`),
      historyPage.goto(`/project/${PROJECT}/history`),
    ])

    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)
    await expect(historyPage.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })

    phase = 'running'

    const releaseRow = historyPage.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
    await expect(releaseRow).toBeVisible({ timeout: 12_000 })
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_JOB_ID)}`),
      { timeout: 12_000 },
    )
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })

    phase = 'cancelled'
    finishStream()

    await expect(page.getByText('Release output was cancelled on both surfaces.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })

    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(releaseRow.getByText('cancelled').first()).toBeVisible({ timeout: 12_000 })
    await expect(historyPage.getByText('No runs yet')).toHaveCount(0)
  })

  // -------------------------------------------------------------------------
  // Ordinary-run auto-attach end-states — spinner clears on all outcomes
  //
  // The existing auto-attach test proves the landing page routes to the session
  // and the spinner appears, but stops before verifying the spinner clears when
  // the stream closes. These three tests pin the end-state for each outcome so
  // an orphaned spinner cannot regress undetected.
  // -------------------------------------------------------------------------
  test('terminal landing page clears spinner and shows exit 0 after an ordinary run completes via stream', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runFinished = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return runFinished
        ? [finishedTerminalRunJob(0, 'Ordinary run success output.')]
        : [runningTerminalRunJob()]
    })
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runFinished
          ? finishedTerminalRunJob(0, 'Ordinary run success output.')
          : runningTerminalRunJob(),
      }),
    )
    await page.route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Ordinary run success output.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: 0, sessionId: RUN_SESSION_ID, provider: 'claude', duration: 900 })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })

    runFinished = true
    finishStream()

    await expect(page.getByText('Ordinary run success output.')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
  })

  test('terminal landing page clears spinner and shows failure detail after an ordinary run fails via stream', async ({
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

    await stubProjectShell(page, () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return runFinished
        ? [finishedTerminalRunJob(2, 'Ordinary run failure output.', failureDetail)]
        : [runningTerminalRunJob()]
    })
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runFinished
          ? finishedTerminalRunJob(2, 'Ordinary run failure output.', failureDetail)
          : runningTerminalRunJob(),
      }),
    )
    await page.route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Ordinary run failure output.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: 2, sessionId: RUN_SESSION_ID, provider: 'claude', detail: failureDetail, duration: 600 })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })

    runFinished = true
    finishStream()

    await expect(page.getByText('Ordinary run failure output.')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(failureDetail)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
  })

  test('terminal landing page clears spinner and shows cancelled state after an ordinary run is cancelled via stream', async ({
    page,
  }) => {
    let serveRunningRun = false
    let runFinished = false
    let runningRunPolls = 0
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page, () => {
      if (!serveRunningRun) return []
      runningRunPolls += 1
      return runFinished
        ? [finishedTerminalRunJob(-3, 'Ordinary run was cancelled.')]
        : [runningTerminalRunJob()]
    })
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: runFinished
          ? finishedTerminalRunJob(-3, 'Ordinary run was cancelled.')
          : runningTerminalRunJob(),
      }),
    )
    await page.route(`**/api/streaming/${RUN_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Ordinary run was cancelled.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: -3, sessionId: RUN_SESSION_ID, provider: 'claude', duration: 400 })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal`)
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0)

    serveRunningRun = true

    await expect.poll(() => runningRunPolls, { timeout: 4_000 }).toBeGreaterThan(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${RUN_SESSION_ID}$`), {
      timeout: 12_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toBeVisible({ timeout: 8_000 })

    runFinished = true
    finishStream()

    await expect(page.getByText('Ordinary run was cancelled.')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByLabel('live run spinner')).toHaveCount(0, { timeout: 8_000 })
  })
})
