import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'terminal-mocked-lifecycle'
const JOB_ID = 'mock-review-live-1'
const SESSION_ID = 'mock-session-live-1'

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

async function stubProjectShell(page: Page): Promise<void> {
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
        json: { jobs: [runningJob()], pendingReleaseProjects: [] },
      }),
  )
}

test.describe('Mocked terminal lifecycle UI', () => {
  test('terminal job deep link shows live run, then clears after streamed success', async ({ page }) => {
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page)
    await page.route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({ json: runningJob() }),
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
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    finishStream()

    await expect(page.getByText('Mocked review output reached the terminal.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`))
  })

  test('terminal job deep link clears live state and shows stream failure details', async ({ page }) => {
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page)
    await page.route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({ json: runningJob() }),
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
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    finishStream()

    await expect(page.getByText('Mocked review output failed in the terminal.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Mock provider failed hard')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`))
  })

  test('terminal job deep link clears live state after streamed cancellation', async ({ page }) => {
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubProjectShell(page)
    await page.route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({ json: runningJob() }),
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
    await expect(page.getByText(/receiving output|waiting for output/)).toBeVisible()

    finishStream()

    await expect(page.getByText('Mocked review output stopped before completion.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByText(/receiving output|waiting for output/)).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`))
  })
})
