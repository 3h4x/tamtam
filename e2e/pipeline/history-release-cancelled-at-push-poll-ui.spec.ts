import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Mocked-API lifecycle test pinning the "cancelled at push" poll-driven path.
//
// Regression coverage for the wall-clock-timeout force-finalize fix: when a
// wedged inline push step is force-finalized by the probe sweep (no user
// interaction), the history tab must transition from "now: push + spinner" to
// "cancelled at push" on the next poll, without a page reload and without an
// orphaned running badge.
//
// Distinct from:
//   history-stop-action-ui.spec.ts        — user Stop button (review step)
//   history-release-cancelled-after-phase  — between-phases cancel (review done,
//                                            next phase never started)
// This spec covers: MID-phase push cancellation via POLL (no user click).

const PROJECT = 'history-cancel-at-push-poll-ui'
const RELEASE_JOB_ID = 'cancel-at-push-release-1'
const PUSH_JOB_ID = 'cancel-at-push-push-1'

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

type MockJob = {
  id: string
  project: string
  kind: string
  status: 'running' | 'done' | 'aborted'
  exit_code: number | null
  started_at: number
  finished_at: number | null
  work_summary?: string | null
  session_id?: string | null
  release_id?: string | null
  parent_job_id?: string | null
  pid?: number
  log_path?: string
  seen?: boolean
}

function makeJob(
  overrides: Partial<MockJob> & Pick<MockJob, 'id' | 'kind' | 'status' | 'exit_code'>,
): MockJob {
  return {
    project: PROJECT,
    started_at: now() - 90,
    finished_at: overrides.status === 'running' ? null : now() - 2,
    work_summary: null,
    session_id: null,
    release_id: null,
    parent_job_id: null,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  }
}

// Phase 1: release + push both mid-run.
// Phase 2 (cancelled-at): the probe sweep force-finalizes the wedged push step;
// both the release and the push child are now aborted with exit_code -3. This
// is the "cancelled AT push" case — the child itself was cancelled.
function jobsFor(cancelled: boolean): MockJob[] {
  return [
    makeJob({
      id: RELEASE_JOB_ID,
      kind: 'release',
      status: cancelled ? 'aborted' : 'running',
      exit_code: cancelled ? -3 : null,
      work_summary: cancelled ? 'Release aborted by wall-clock timeout' : 'Push running',
    }),
    makeJob({
      id: PUSH_JOB_ID,
      kind: 'push',
      // Push step is also aborted (exit_code -3) — distinguishes "cancelled AT"
      // from "cancelled AFTER" where the child exits cleanly (exit_code 0).
      status: cancelled ? 'aborted' : 'running',
      exit_code: cancelled ? -3 : null,
      release_id: RELEASE_JOB_ID,
      parent_job_id: RELEASE_JOB_ID,
      work_summary: cancelled ? 'Push cancelled by wall-clock abort' : 'Pushing to remote',
    }),
  ]
}

async function stubHistoryShell(page: Page, getCancelled: () => boolean): Promise<void> {
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
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
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
      const jobs = jobsFor(getCancelled())
      route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } })
    },
  )
  await page.route('**/api/jobs/counts**', (route: Route) => {
    const jobs = jobsFor(getCancelled())
    const running = jobs.filter((job) => job.status === 'running').length
    route.fulfill({
      json: {
        total: jobs.length,
        byKind: Object.fromEntries(jobs.map((job) => [job.kind, 1])),
        byStatus: { running, done: jobs.length - running, aborted: 0, failed: 0 },
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        cost: { total: 0, monthToDate: 0 },
      },
    })
  })
}

function releaseRow(page: Page) {
  return page.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
}

test.describe('History tab: release cancelled mid-push via poll (no user interaction)', () => {
  test('release force-finalized at push renders "cancelled at push" without orphaned spinner', async ({
    page,
  }) => {
    let cancelled = false

    await stubHistoryShell(page, () => cancelled)
    await page.goto(`/project/${PROJECT}/history`)

    // Phase 1: release and push both running.
    const row = releaseRow(page)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText(/now: push/i)).toBeVisible()

    const stableUrl = page.url()

    // Simulate the probe sweep force-finalizing the wedged push step: both rows
    // flip to aborted on the next poll. No user button click involved.
    cancelled = true

    // Phase 2: the progress label must read "cancelled at push" — the push step
    // itself was aborted (distinguishing it from "cancelled after push" where
    // push exits cleanly). The running spinner must clear.
    await expect(row.getByText(/cancelled at push/i)).toBeVisible({ timeout: 15_000 })
    await expect(row.getByText(/cancelled after push/i)).toHaveCount(0)
    await expect(row.getByText(/now: push/i)).toHaveCount(0, { timeout: 15_000 })
    await expect(row.getByLabel('running')).toHaveCount(0)

    // No page reload occurred.
    await expect(page).toHaveURL(stableUrl)
  })
})
