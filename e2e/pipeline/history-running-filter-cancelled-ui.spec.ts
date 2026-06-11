import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Narrow lifecycle edge: when the active history filter is "running", a job
// that cancels by poll should leave the filtered view, clear the running badge,
// and remain available as a cancelled row after filters are cleared.

const PROJECT = 'history-running-filter-cancelled'
const RUN_PROMPT = 'Run that cancels while the running filter is active'

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
  seen: boolean
  pid: number
  log_path: string
}

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

function makeJob(cancelled: boolean): MockJob {
  return {
    id: 'history-running-filter-cancelled-run-1',
    project: PROJECT,
    kind: 'run',
    prompt: RUN_PROMPT,
    user_prompt: RUN_PROMPT,
    work_summary: cancelled ? 'Cancelled by operator while filtered' : 'Still streaming output',
    session_id: 'sess-history-running-filter-cancelled',
    status: cancelled ? 'done' : 'running',
    exit_code: cancelled ? -3 : null,
    started_at: now() - 80,
    finished_at: cancelled ? now() - 4 : null,
    seen: true,
    pid: 0,
    log_path: '',
  }
}

async function stubHistoryShell(page: Page, isCancelled: () => boolean): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
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
    route.fulfill({ json: { actions: [] } }),
  )
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const job = makeJob(isCancelled())
      route.fulfill({ json: { jobs: [job], total: 1, pendingReleaseProjects: [] } })
    },
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const job = makeJob(isCancelled())
      const running = job.status === 'running' ? 1 : 0
      route.fulfill({
        json: {
          total: 1,
          byKind: { run: 1 },
          byStatus: {
            running,
            done: 1 - running,
            aborted: job.exit_code === -3 ? 1 : 0,
            failed: job.exit_code !== null && job.exit_code !== 0 ? 1 : 0,
          },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      })
    },
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
}

function runRow(page: Page) {
  return page.getByRole('button').filter({ hasText: RUN_PROMPT }).first()
}

test.describe('History running filter cancellation transition', () => {
  test('cancelled run leaves the active running filter without an orphan running badge', async ({
    page,
  }) => {
    let cancelled = false

    await stubHistoryShell(page, () => cancelled)
    await page.goto(`/project/${PROJECT}/history`)

    const runningChip = page.getByRole('button', { name: /^running 1$/ })
    await expect(runningChip).toBeVisible({ timeout: 8_000 })
    await runningChip.click()

    const row = runRow(page)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText('Still streaming output')).toBeVisible()

    cancelled = true

    await expect(page.getByText('Nothing is running right now')).toBeVisible({ timeout: 12_000 })
    await expect(
      page.getByText('This project has no active terminal, agent, or pipeline work at the moment.'),
    ).toBeVisible()
    await expect(row).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByRole('button', { name: /^running 0$/ })).toBeVisible()

    await page.getByRole('button', { name: 'Clear filters', exact: true }).click()

    const cancelledRow = runRow(page)
    await expect(cancelledRow).toBeVisible({ timeout: 8_000 })
    await expect(cancelledRow.getByText('cancelled', { exact: true })).toBeVisible()
    await expect(cancelledRow.getByText('Cancelled by operator while filtered')).toBeVisible()
    await expect(cancelledRow.getByLabel('running')).toHaveCount(0)
  })
})
