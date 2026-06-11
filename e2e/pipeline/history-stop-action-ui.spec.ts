import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'history-stop-ui'
const RUN_JOB_ID = 'history-stop-run-1'
const RELEASE_JOB_ID = 'history-stop-release-1'
const REVIEW_JOB_ID = 'history-stop-review-1'

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
  prompt?: string | null
  user_prompt?: string | null
  work_summary?: string | null
  session_id?: string | null
  release_id?: string | null
  parent_job_id?: string | null
  pid?: number
  log_path?: string
  seen?: boolean
}

function makeJob(overrides: Partial<MockJob> & Pick<MockJob, 'id' | 'kind' | 'status' | 'exit_code'>): MockJob {
  const finished = overrides.status === 'running' ? null : now() - 4
  return {
    project: PROJECT,
    started_at: now() - 80,
    finished_at: finished,
    prompt: null,
    user_prompt: null,
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

async function stubHistoryShellRoutes(page: Page): Promise<void> {
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
}

async function stubHistoryJobs(
  page: Page,
  jobsForCurrentPhase: () => MockJob[],
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const jobs = jobsForCurrentPhase()
      route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } })
    },
  )
  await page.route('**/api/jobs/counts**', (route: Route) => {
    const jobs = jobsForCurrentPhase()
    const running = jobs.filter((job) => job.status === 'running').length
    const failed = jobs.filter((job) => job.exit_code !== null && job.exit_code !== 0).length
    route.fulfill({
      json: {
        total: jobs.length,
        byKind: Object.fromEntries(jobs.map((job) => [job.kind, 1])),
        byStatus: {
          running,
          done: jobs.length - running,
          aborted: 0,
          failed,
        },
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        cost: { total: 0, monthToDate: 0 },
      },
    })
  })
}

function runRow(page: Page) {
  return page.getByRole('button').filter({ hasText: 'Stop this ordinary run' }).first()
}

function releaseRow(page: Page) {
  return page.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
}

test.describe('History stop action lifecycle', () => {
  test('ordinary run Stop calls DELETE and clears the running badge without reload', async ({
    page,
  }) => {
    let cancelled = false
    let deleteCalls = 0

    await stubHistoryShellRoutes(page)
    await stubHistoryJobs(page, () => [
      makeJob({
        id: RUN_JOB_ID,
        kind: 'run',
        status: cancelled ? 'done' : 'running',
        exit_code: cancelled ? -3 : null,
        prompt: 'Stop this ordinary run',
        user_prompt: 'Stop this ordinary run',
        work_summary: cancelled ? 'Cancelled by operator' : 'Still running',
        session_id: 'sess-history-stop-run',
      }),
    ])
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalls += 1
        cancelled = true
        route.fulfill({ json: { status: 'cancelled' } })
        return
      }
      route.continue()
    })

    await page.goto(`/project/${PROJECT}/history`)

    const row = runRow(page)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText('Still running')).toBeVisible()

    await row.getByRole('button', { name: 'Stop' }).click()

    await expect.poll(() => deleteCalls).toBe(1)
    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 8_000 })
    await expect(row.getByText('Cancelled by operator')).toBeVisible()
    await expect(row.getByLabel('running')).toHaveCount(0)
  })

  test('release Stop calls the abort endpoint and removes the release spinner without reload', async ({
    page,
  }) => {
    let aborted = false
    let abortCalls = 0

    await stubHistoryShellRoutes(page)
    await stubHistoryJobs(page, () => [
      makeJob({
        // A finalized abort sets abortedAt, which the storage layer maps to
        // status 'aborted' (lib/jobs/storage.ts) — not a plain 'done'. Mocking
        // 'done' here misclassifies the release as failed instead of cancelled.
        id: RELEASE_JOB_ID,
        kind: 'release',
        status: aborted ? 'aborted' : 'running',
        exit_code: aborted ? -3 : null,
        work_summary: aborted ? 'Release aborted by operator' : 'Review running',
      }),
      makeJob({
        id: REVIEW_JOB_ID,
        kind: 'review',
        status: aborted ? 'aborted' : 'running',
        exit_code: aborted ? -3 : null,
        release_id: RELEASE_JOB_ID,
        parent_job_id: RELEASE_JOB_ID,
        work_summary: aborted ? 'Review cancelled by release abort' : 'Reviewing changes',
      }),
    ])
    await page.route(`**/api/projects/by-project/${PROJECT}/release/abort`, (route: Route) => {
      if (route.request().method() === 'POST') {
        abortCalls += 1
        aborted = true
        route.fulfill({ json: { status: 'aborted' } })
        return
      }
      route.continue()
    })

    await page.goto(`/project/${PROJECT}/history`)

    const row = releaseRow(page)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText(/now: review/i)).toBeVisible()

    await row.getByRole('button', { name: 'Stop' }).click()

    await expect.poll(() => abortCalls).toBe(1)
    await expect(row.getByText(/cancelled at review/i)).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toHaveCount(0)
    await expect(row.getByText(/now: review/i)).toHaveCount(0)
  })

  // -------------------------------------------------------------------------
  // Deferred abort — the abort endpoint returns 409 `abort_pending` because a
  // push/commit step is still draining. The button must surface "abort pending"
  // (not "stopped") and the release spinner must persist: the run is not yet
  // terminal, so clearing it would orphan the UI. After the reset timeout the
  // button returns to "Stop" with the release still running.
  // -------------------------------------------------------------------------
  test('release Stop shows "abort pending" and keeps the spinner when abort is deferred', async ({
    page,
  }) => {
    let abortCalls = 0

    await stubHistoryShellRoutes(page)
    // The release never finishes — the draining push step keeps it running.
    await stubHistoryJobs(page, () => [
      makeJob({
        id: RELEASE_JOB_ID,
        kind: 'release',
        status: 'running',
        exit_code: null,
        work_summary: 'Push running',
      }),
      makeJob({
        id: REVIEW_JOB_ID,
        kind: 'push',
        status: 'running',
        exit_code: null,
        release_id: RELEASE_JOB_ID,
        parent_job_id: RELEASE_JOB_ID,
        work_summary: 'Pushing changes',
      }),
    ])
    await page.route(`**/api/projects/by-project/${PROJECT}/release/abort`, (route: Route) => {
      if (route.request().method() === 'POST') {
        abortCalls += 1
        route.fulfill({
          status: 409,
          json: {
            status: 'abort_pending',
            detail: 'Timed out waiting for push to stop cleanly',
            release_id: RELEASE_JOB_ID,
            killed_job_id: null,
          },
        })
        return
      }
      route.continue()
    })

    await page.goto(`/project/${PROJECT}/history`)

    const row = releaseRow(page)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()

    await row.getByRole('button', { name: 'Stop' }).click()

    await expect.poll(() => abortCalls).toBe(1)

    // Button reflects the deferred abort and is disabled while it persists.
    const abortPendingBtn = row.getByRole('button', { name: 'abort pending' })
    await expect(abortPendingBtn).toBeVisible({ timeout: 8_000 })
    await expect(abortPendingBtn).toBeDisabled()

    // The release is still draining — the spinner must NOT be cleared.
    await expect(row.getByLabel('running')).toBeVisible()

    // After the ~2.5 s reset the button returns to "Stop", still actionable.
    await expect(row.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 5_000 })
    await expect(row.getByRole('button', { name: 'Stop' })).toBeEnabled()
    await expect(row.getByLabel('running')).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Stop failure path — DELETE returns non-OK; button shows "failed" briefly
  // then resets to "Stop" while the running badge persists (job still running).
  // -------------------------------------------------------------------------
  test('Stop button shows "failed" label and running badge persists when DELETE returns 500', async ({
    page,
  }) => {
    await stubHistoryShellRoutes(page)
    await stubHistoryJobs(page, () => [
      makeJob({
        id: RUN_JOB_ID,
        kind: 'run',
        status: 'running',
        exit_code: null,
        prompt: 'Stop this ordinary run',
        user_prompt: 'Stop this ordinary run',
        work_summary: 'Still running after failed stop',
        session_id: 'sess-history-stop-fail',
      }),
    ])
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, (route: Route) => {
      if (route.request().method() === 'DELETE') {
        route.fulfill({
          status: 500,
          json: { detail: 'Internal error stopping the job process' },
        })
        return
      }
      route.continue()
    })

    await page.goto(`/project/${PROJECT}/history`)

    const row = runRow(page)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()

    const stopBtn = row.getByRole('button', { name: 'Stop' })
    await expect(stopBtn).toBeVisible()
    await stopBtn.click()

    // Stop button flips to "failed" and is disabled while the error state persists.
    await expect(row.getByRole('button', { name: 'failed' })).toBeVisible({ timeout: 5_000 })
    await expect(row.getByRole('button', { name: 'failed' })).toBeDisabled()

    // Running badge must still be present — the job was not stopped.
    await expect(row.getByLabel('running')).toBeVisible()

    // After the reset timeout (~2.5 s) the button returns to "Stop".
    await expect(row.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 5_000 })
    // Running badge must still be present after the button resets.
    await expect(row.getByLabel('running')).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Stop in-flight — "stopping" label + disabled while DELETE is pending;
  // button resets to "Stop" after the request completes (success path but
  // delayed, so we can observe the intermediate state).
  // -------------------------------------------------------------------------
  test('Stop button shows "stopping" and is disabled while the DELETE is in-flight', async ({
    page,
  }) => {
    let resolveDELETE!: () => void
    const deleteStarted = new Promise<void>((res) => { resolveDELETE = res })
    let deleteCompleted = false

    await stubHistoryShellRoutes(page)
    await stubHistoryJobs(page, () => [
      makeJob({
        id: RUN_JOB_ID,
        kind: 'run',
        status: deleteCompleted ? 'done' : 'running',
        exit_code: deleteCompleted ? -2 : null,
        prompt: 'Stop this ordinary run',
        user_prompt: 'Stop this ordinary run',
        work_summary: deleteCompleted ? 'Cancelled by operator' : 'In-flight stop test',
        session_id: 'sess-history-stop-inflight',
      }),
    ])

    // Hold the DELETE in-flight until the test signals completion.
    await page.route(`**/api/jobs/${RUN_JOB_ID}`, async (route: Route) => {
      if (route.request().method() === 'DELETE') {
        resolveDELETE()
        // Await an external signal before resolving so the test can observe the
        // intermediate UI state. The delete-started promise resolves when the
        // handler is entered; we then wait for the test to advance via a short
        // delay, then fulfill.
        await new Promise<void>((res) => setTimeout(res, 600))
        deleteCompleted = true
        route.fulfill({ json: { status: 'cancelled' } })
        return
      }
      route.continue()
    })

    await page.goto(`/project/${PROJECT}/history`)

    const row = runRow(page)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()

    const stopBtn = row.getByRole('button', { name: 'Stop' })
    await expect(stopBtn).toBeEnabled()
    await stopBtn.click()

    // Wait until the DELETE handler is entered (the click was registered and
    // the request left the browser) before asserting the in-flight state.
    await deleteStarted

    // While the request is pending the button label changes to "stopping"
    // and the button is disabled so the user cannot double-click.
    await expect(row.getByRole('button', { name: 'stopping' })).toBeVisible({ timeout: 3_000 })
    await expect(row.getByRole('button', { name: 'stopping' })).toBeDisabled()

    // After the DELETE resolves and the poll catches up, the badge clears.
    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 8_000 })
  })
})
