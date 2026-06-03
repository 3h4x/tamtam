import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Custom actions are per-project bash commands surfaced as buttons. Their jobs
// carry `kind === <actionName>`, which buckets to 'other' → the runs list shows
// them with the "action" badge plus the action name. No other spec
// exercises this run kind, so this covers the running → done / running → exit
// lifecycle for a custom action row, fully mocked (no shim/exec needed).

const PROJECT = 'history-custom-action-live'
const ACTION_NAME = 'deploy-preview'

const now = () => Math.floor(Date.now() / 1000)

type MockJob = {
  id: string
  project: string
  kind: string
  prompt: string | null
  user_prompt: string | null
  work_summary: string | null
  session_id: string | null
  status: 'running' | 'done'
  exit_code: number | null
  started_at: number
  finished_at: number | null
  seen?: boolean
  pid?: number
  log_path?: string
}

function makeTask(project: string) {
  return {
    id: `${project}-1`,
    project,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${project}`,
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

function makeJob(overrides: MockJob): MockJob {
  return {
    seen: true,
    pid: 0,
    log_path: '',
    ...overrides,
  }
}

function runRow(page: Page, text: string) {
  return page.getByRole('button').filter({ hasText: text }).filter({ hasText: 'started' }).first()
}

function filterChip(page: Page, label: 'running' | 'failed' | 'all') {
  return page.getByRole('button', { name: new RegExp(`^${label} \\d+$`, 'i') }).first()
}

async function stubHistoryShell(page: Page, jobs: () => MockJob[]): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask(PROJECT)], priorities: [], issueCounts: {} } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({
      json: {
        project: PROJECT,
        test_command: '',
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
      },
    }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [{ name: ACTION_NAME, command: 'echo deploy' }] } }),
  )
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  )
  await page.route(
    (url) =>
      url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const currentJobs = jobs()
      route.fulfill({
        json: { jobs: currentJobs, total: currentJobs.length, pendingReleaseProjects: [] },
      })
    },
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const currentJobs = jobs()
      const running = currentJobs.filter((job) => job.status === 'running').length
      const failed = currentJobs.filter(
        (job) => job.exit_code !== null && job.exit_code !== 0,
      ).length
      const byKind = currentJobs.reduce<Record<string, number>>((acc, job) => {
        acc[job.kind] = (acc[job.kind] ?? 0) + 1
        return acc
      }, {})
      route.fulfill({
        json: {
          total: currentJobs.length,
          byKind,
          byStatus: {
            running,
            done: currentJobs.filter((job) => job.status === 'done').length,
            aborted: 0,
            failed,
          },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      })
    },
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
}

test.describe('History tab custom action live polling', () => {
  test('custom action flips from running to done without reload and shows the action badge', async ({
    page,
  }) => {
    let serveRunning = true

    await stubHistoryShell(page, () => [
      makeJob({
        id: 'custom-action-done-1',
        project: PROJECT,
        kind: ACTION_NAME,
        prompt: null,
        user_prompt: null,
        work_summary: null,
        session_id: null,
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 6,
        finished_at: serveRunning ? null : now() - 1,
      }),
    ])

    await page.goto(`/project/${PROJECT}/history`)

    const row = runRow(page, ACTION_NAME)
    await expect(row).toBeVisible({ timeout: 8_000 })
    // Custom-action jobs bucket to 'other' → the "action" kind badge.
    await expect(row.getByText('action', { exact: true })).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(filterChip(page, 'running')).toHaveText('running 1', { timeout: 8_000 })

    serveRunning = false

    await expect(row.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(filterChip(page, 'running')).toHaveCount(0, { timeout: 12_000 })
  })

  test('custom action flips from running to exit 1 without reload and lands in the failed filter', async ({
    page,
  }) => {
    let serveRunning = true

    await stubHistoryShell(page, () => [
      makeJob({
        id: 'custom-action-fail-1',
        project: PROJECT,
        kind: ACTION_NAME,
        prompt: null,
        user_prompt: null,
        work_summary: null,
        session_id: null,
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 1,
        started_at: now() - 12,
        finished_at: serveRunning ? null : now() - 1,
      }),
    ])

    await page.goto(`/project/${PROJECT}/history`)

    const row = runRow(page, ACTION_NAME)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 8_000 })

    serveRunning = false

    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(filterChip(page, 'running')).toHaveCount(0, { timeout: 12_000 })
    await expect(filterChip(page, 'failed')).toHaveText('failed 1', { timeout: 12_000 })
  })
})
