import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'task-detail-live'
const TASK_ID = `${PROJECT}-review`

type TaskDetailResponse = {
  id: string
  project: string
  job: string | null
  prompt_path: string | null
  prompt_content: string | null
  memory_path: string | null
  memory_content: string | null
  persona: string[]
  run_history: Array<{
    started: string | null
    ended: string | null
    duration_s: number | null
    exit_code: number | null
  }>
}

function makeTask() {
  return {
    id: TASK_ID,
    project: PROJECT,
    job: 'review',
    priority: null,
    launchctl: 'running',
    path: `/tmp/${PROJECT}`,
    fires_at: '*/5 * * * *',
    paused: false,
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

function runningDetail(): TaskDetailResponse {
  return {
    id: TASK_ID,
    project: PROJECT,
    job: 'review',
    prompt_path: null,
    prompt_content: null,
    memory_path: null,
    memory_content: null,
    persona: [],
    run_history: [
      {
        started: '2026-05-28T10:00:00.000Z',
        ended: null,
        duration_s: null,
        exit_code: null,
      },
    ],
  }
}

function finishedDetail(exitCode: number): TaskDetailResponse {
  return {
    ...runningDetail(),
    run_history: [
      {
        started: '2026-05-28T10:00:00.000Z',
        ended: '2026-05-28T10:00:12.000Z',
        duration_s: 12,
        exit_code: exitCode,
      },
    ],
  }
}

async function stubTaskPage(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [makeTask()],
        priorities: [],
        issueCounts: {},
      },
    }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
}

test.describe('Task detail live polling', () => {
  test('transient task detail load failure can be retried without navigation', async ({ page }) => {
    let shouldFail = true

    await stubTaskPage(page)
    await page.route(`**/api/projects/${encodeURIComponent(TASK_ID)}/detail`, (route: Route) => {
      if (shouldFail) {
        route.fulfill({
          status: 500,
          json: { detail: 'temporary backend failure' },
        })
        return
      }
      route.fulfill({ json: finishedDetail(0) })
    })

    await page.goto(`/project/${PROJECT}/task/review`)

    await expect(page.getByText(/Error: Failed to fetch task detail/i)).toBeVisible({
      timeout: 8_000,
    })
    const stableUrl = page.url()

    shouldFail = false
    await page.getByRole('button', { name: 'Retry' }).click()

    await expect(page.getByRole('heading', { name: `${PROJECT} / review` })).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('12s').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('0').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/Error: Failed to fetch task detail/i)).toHaveCount(0)
    await expect(page).toHaveURL(stableUrl)
  })

  test('run history flips from running to success without reload', async ({ page }) => {
    let serveRunning = true

    await stubTaskPage(page)
    await page.route(
      `**/api/projects/${encodeURIComponent(TASK_ID)}/detail`,
      (route: Route) => route.fulfill({ json: serveRunning ? runningDetail() : finishedDetail(0) }),
    )

    await page.goto(`/project/${PROJECT}/task/review`)

    await expect(page.getByRole('heading', { name: `${PROJECT} / review` })).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('running...').first()).toBeVisible({ timeout: 8_000 })

    const stableUrl = page.url()
    serveRunning = false

    await expect(page.getByText('12s').first()).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('0').first()).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('running', { exact: true })).toHaveCount(0)
    await expect(page.getByText('running...', { exact: true })).toHaveCount(0)
    await expect(page).toHaveURL(stableUrl)
  })

  test('run history renders cancelled when a running task aborts', async ({ page }) => {
    let serveRunning = true

    await stubTaskPage(page)
    await page.route(
      `**/api/projects/${encodeURIComponent(TASK_ID)}/detail`,
      (route: Route) => route.fulfill({ json: serveRunning ? runningDetail() : finishedDetail(-3) }),
    )

    await page.goto(`/project/${PROJECT}/task/review`)

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 })

    serveRunning = false

    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('running', { exact: true })).toHaveCount(0)
    await expect(page.getByText('-3')).toHaveCount(0)
  })

  test('run history renders a failed exit code when a running task fails without reload', async ({
    page,
  }) => {
    let serveRunning = true

    await stubTaskPage(page)
    await page.route(
      `**/api/projects/${encodeURIComponent(TASK_ID)}/detail`,
      (route: Route) => route.fulfill({ json: serveRunning ? runningDetail() : finishedDetail(2) }),
    )

    await page.goto(`/project/${PROJECT}/task/review`)

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('running...').first()).toBeVisible({ timeout: 8_000 })

    serveRunning = false

    await expect(page.getByText('12s').first()).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('2').first()).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('running', { exact: true })).toHaveCount(0)
    await expect(page.getByText('running...', { exact: true })).toHaveCount(0)
    await expect(page.getByText('cancelled')).toHaveCount(0)
  })
})
