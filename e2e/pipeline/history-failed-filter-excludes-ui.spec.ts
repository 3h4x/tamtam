import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Pure page.route() UI spec — this project is intentionally NOT in global-setup's
// PROJECTS list; every shell request the history tab makes is stubbed below.
//
// Gap covered: the history "failed" filter chip is really a *needs-attention*
// filter (entryNeedsAttention), not a literal exit-code filter. Existing specs
// only ever transition a single job through running → failed, so they never
// prove the filter EXCLUDES the other lifecycle states when a heterogeneous list
// is present at once. This asserts that with a running run, a clean exit-0 run,
// and a failed exit-1 run all on screen, clicking "failed" shows only the failed
// row (hiding both the running and the successful run), and "running" shows only
// the live row — no reload, no orphaned rows.

const PROJECT = 'history-failed-filter-excludes'

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

const RUNNING_SUMMARY = 'Streaming the still-running provider output'
const SUCCESS_SUMMARY = 'Completed the requested work cleanly'
const FAILURE_SUMMARY = 'Provider exited non-zero before finishing'

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

function makeJob(overrides: Partial<MockJob> & Pick<MockJob, 'id' | 'kind' | 'prompt' | 'user_prompt' | 'work_summary' | 'session_id' | 'status' | 'exit_code' | 'started_at' | 'finished_at'>): MockJob {
  return {
    project: PROJECT,
    seen: true,
    pid: 0,
    log_path: '',
    ...overrides,
  }
}

function runRow(page: Page, text: string) {
  return page.getByRole('button').filter({ hasText: text }).first()
}

function filterChip(page: Page, label: 'running' | 'failed' | 'all') {
  return page.getByRole('button', { name: new RegExp(`^${label} \\d+$`, 'i') }).first()
}

const JOBS: MockJob[] = [
  makeJob({
    id: 'mixed-running',
    kind: 'run',
    prompt: 'A run that is still live',
    user_prompt: 'A run that is still live',
    session_id: 'sess-mixed-running',
    status: 'running',
    exit_code: null,
    started_at: now() - 20,
    finished_at: null,
    work_summary: RUNNING_SUMMARY,
  }),
  makeJob({
    id: 'mixed-success',
    kind: 'run',
    prompt: 'A run that finished successfully',
    user_prompt: 'A run that finished successfully',
    session_id: 'sess-mixed-success',
    status: 'done',
    exit_code: 0,
    started_at: now() - 120,
    finished_at: now() - 90,
    work_summary: SUCCESS_SUMMARY,
  }),
  makeJob({
    id: 'mixed-failure',
    kind: 'run',
    prompt: 'A run that failed',
    user_prompt: 'A run that failed',
    session_id: 'sess-mixed-failure',
    status: 'done',
    exit_code: 1,
    started_at: now() - 60,
    finished_at: now() - 40,
    work_summary: FAILURE_SUMMARY,
  }),
]

async function stubHistoryShell(page: Page, jobs: MockJob[]): Promise<void> {
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
    route.fulfill({ json: { actions: [] } }),
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
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const running = jobs.filter((job) => job.status === 'running').length
      const failed = jobs.filter((job) => job.exit_code !== null && job.exit_code !== 0).length
      const byKind = jobs.reduce<Record<string, number>>((acc, job) => {
        acc[job.kind] = (acc[job.kind] ?? 0) + 1
        return acc
      }, {})
      route.fulfill({
        json: {
          total: jobs.length,
          byKind,
          byStatus: {
            running,
            done: jobs.filter((job) => job.status === 'done').length,
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

test.describe('History failed filter excludes other lifecycle states', () => {
  test('failed filter shows only the needs-attention run, hiding running and successful runs', async ({
    page,
  }) => {
    await stubHistoryShell(page, JOBS)

    await page.goto(`/project/${PROJECT}/history`)

    // All three rows are present under the default "all" filter.
    const runningRow = runRow(page, RUNNING_SUMMARY)
    const successRow = runRow(page, SUCCESS_SUMMARY)
    const failureRow = runRow(page, FAILURE_SUMMARY)
    await expect(runningRow).toBeVisible({ timeout: 8_000 })
    await expect(successRow).toBeVisible({ timeout: 8_000 })
    await expect(failureRow).toBeVisible({ timeout: 8_000 })

    // The chip counts are derived client-side from the heterogeneous list:
    // exactly one running and exactly one needs-attention entry.
    await expect(filterChip(page, 'failed')).toHaveText('failed 1', { timeout: 8_000 })
    await expect(filterChip(page, 'running')).toHaveText('running 1', { timeout: 8_000 })

    // Clicking "failed" must leave only the failed run on screen — the clean
    // exit-0 run and the still-running run are excluded, not merely de-emphasised.
    await filterChip(page, 'failed').click()
    await expect(runRow(page, FAILURE_SUMMARY)).toBeVisible({ timeout: 8_000 })
    await expect(runRow(page, FAILURE_SUMMARY).getByText('exit 1', { exact: true })).toBeVisible()
    await expect(runRow(page, SUCCESS_SUMMARY)).toHaveCount(0, { timeout: 8_000 })
    await expect(runRow(page, RUNNING_SUMMARY)).toHaveCount(0, { timeout: 8_000 })

    // Switching to "running" inverts the exclusion: only the live run remains,
    // and it carries a running badge with no failed/exit decoration.
    await filterChip(page, 'running').click()
    const liveRow = runRow(page, RUNNING_SUMMARY)
    await expect(liveRow).toBeVisible({ timeout: 8_000 })
    await expect(liveRow.getByLabel('running')).toBeVisible()
    await expect(runRow(page, FAILURE_SUMMARY)).toHaveCount(0, { timeout: 8_000 })
    await expect(runRow(page, SUCCESS_SUMMARY)).toHaveCount(0, { timeout: 8_000 })
  })
})
