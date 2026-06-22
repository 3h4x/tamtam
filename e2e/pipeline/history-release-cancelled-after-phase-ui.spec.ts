import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Mocked-API lifecycle test for the history tab, pinning the "cancelled after"
// release-progress branch (lib release-progress buildReleaseProgressLabel:
// release.status === 'aborted' AND last child step NOT aborted).
//
// This is the BETWEEN-PHASES cancellation: a child step (review) finished
// cleanly with exit 0, then the release was aborted before the next phase
// spawned. It must render "cancelled after review" — distinct from the
// MID-PHASE case ("cancelled at review", child itself aborted) already covered
// by history-stop-action-ui.spec.ts.
//
// Unlike history-stop-action, this transition is purely poll-driven: no Stop
// button click and no abort endpoint — it proves the history tab re-renders the
// cancelled release group from polled job data alone, without a page reload and
// without orphaning the running spinner.

const PROJECT = 'history-release-cancelled-after-ui'
const RELEASE_JOB_ID = 'history-cancel-after-release-1'
const REVIEW_JOB_ID = 'history-cancel-after-review-1'

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
    started_at: now() - 80,
    finished_at: overrides.status === 'running' ? null : now() - 4,
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

// Phase 1: release + review both running.
// Phase 2 (cancelled-after): review finished cleanly (done, exit 0); the
// release was then aborted before any further step — the hallmark of a
// between-phases cancellation.
function jobsFor(cancelled: boolean): MockJob[] {
  return [
    makeJob({
      id: RELEASE_JOB_ID,
      kind: 'release',
      status: cancelled ? 'aborted' : 'running',
      exit_code: cancelled ? -3 : null,
      work_summary: cancelled ? 'Release aborted between phases' : 'Review running',
    }),
    makeJob({
      id: REVIEW_JOB_ID,
      kind: 'review',
      // The review step itself succeeded — it is NOT aborted. Only the parent
      // release is. This is what separates "cancelled after" from "cancelled at".
      status: cancelled ? 'done' : 'running',
      exit_code: cancelled ? 0 : null,
      release_id: RELEASE_JOB_ID,
      parent_job_id: RELEASE_JOB_ID,
      work_summary: cancelled ? 'Review completed before cancel' : 'Reviewing changes',
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

test.describe('History tab: release cancelled between phases', () => {
  test('release aborted after a clean review renders "cancelled after review" via poll, no orphan spinner', async ({
    page,
  }) => {
    let cancelled = false

    await stubHistoryShell(page, () => cancelled)
    await page.goto(`/project/${PROJECT}/history`)

    // Phase 1: release running with review in flight.
    const row = releaseRow(page)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText(/now: review/i)).toBeVisible()

    const stableUrl = page.url()

    // Flip to the between-phases cancelled state on the next poll.
    cancelled = true

    // Phase 2: the progress label must read "cancelled after review" — the
    // review ✓'d, then the release was aborted before the next phase. The
    // running spinner must clear and "now: review" must disappear.
    await expect(row.getByText(/cancelled after review/i)).toBeVisible({ timeout: 15_000 })
    await expect(row.getByText(/cancelled at review/i)).toHaveCount(0)
    await expect(row.getByText(/now: review/i)).toHaveCount(0, { timeout: 15_000 })
    await expect(row.getByLabel('running')).toHaveCount(0)

    // No page reload occurred.
    await expect(page).toHaveURL(stableUrl)
  })
})
