import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'history-log-retention-pruned-ui'

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
  log_pruned?: boolean
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

function prunedJob(): MockJob {
  return {
    id: 'run-log-pruned-1',
    project: PROJECT,
    kind: 'run',
    prompt: 'Completed run with a retained history row but pruned log',
    user_prompt: 'Completed run with a retained history row but pruned log',
    work_summary: 'Finished cleanly before log retention removed the file.',
    session_id: 'sess-run-log-pruned-1',
    status: 'done',
    exit_code: 0,
    started_at: now() - 180,
    finished_at: now() - 90,
    seen: true,
    pid: 0,
    log_path: '',
    log_pruned: true,
  }
}

async function stubHistoryShell(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [makeTask()],
        priorities: [],
        issueCounts: {},
      },
    }),
  )
  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) =>
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
    route.fulfill({
      json: { branch: 'master', defaultBranch: 'master', commitsAhead: null },
    }),
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
      const jobs = [prunedJob()]
      route.fulfill({
        json: {
          jobs,
          total: jobs.length,
          pendingReleaseProjects: [],
        },
      })
    },
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          total: 1,
          byKind: { run: 1 },
          byStatus: { running: 0, done: 1, aborted: 0, failed: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
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

test.describe('History tab log-retention state', () => {
  test('completed runs with pruned logs keep their done badge and show the retention badge', async ({
    page,
  }) => {
    await stubHistoryShell(page)

    await page.goto(`/project/${PROJECT}/history`)

    const row = page.getByRole('button').filter({
      hasText: 'Completed run with a retained history row but pruned log',
    }).first()
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByText('done', { exact: true }).first()).toBeVisible()
    await expect(row.getByLabel('running')).toHaveCount(0)

    const prunedBadge = row.getByText('pruned', { exact: true })
    await expect(prunedBadge).toBeVisible()
    await expect(prunedBadge).toHaveAttribute('title', 'Log file deleted by retention policy')
    await expect(row.getByText('Finished cleanly before log retention removed the file.')).toBeVisible()
  })
})
