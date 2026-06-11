import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// An ordinary terminal run that auto-triggered a release which then FAILED in a
// child step (here: a fix step exited non-zero, with completed children) is a
// recoverable "failed" outcome — not a hard "blocked" one. The History tab
// nests that release under the run row, so the run row must carry the
// "Continue release" action (not "Retry release"). The action posts a new
// release attempt targeting the OWNED release id, and is disabled when jobs are
// globally paused. The failing child is a `fix` step (not commit/push) so the
// retryable-step button does not appear and "Continue release" is isolated.

const PROJECT = 'history-continue-release-owned-failed-ui'
const RUN_ID = 'continue-owned-run'
const RELEASE_ID = 'continue-owned-release'
const RUN_PROMPT = 'Investigate the regression and ship the fix.'

const now = () => Math.floor(Date.now() / 1000)

type MockJob = {
  id: string
  project: string
  kind: string
  status: 'done' | 'running' | 'aborted'
  exit_code: number | null
  started_at: number
  finished_at: number | null
  pid: number
  log_path: string
  seen: boolean
  session_id: string | null
  release_id?: string | null
  parent_job_id?: string | null
  context_meta: string | null
  provider: string
  work_summary: string | null
  user_prompt?: string | null
  prompt?: string | null
  detail?: string | null
  verdict?: string | null
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
    changes: 1,
    unpushed: 1,
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

function agentOwnedFailedReleaseJobs(): MockJob[] {
  const started = now() - 120
  return [
    {
      id: RUN_ID,
      project: PROJECT,
      kind: 'run',
      status: 'done',
      exit_code: 0,
      started_at: started,
      finished_at: started + 10,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'continue-owned-session',
      context_meta: null,
      provider: 'claude',
      work_summary: null,
      user_prompt: RUN_PROMPT,
      prompt: RUN_PROMPT,
    },
    {
      id: RELEASE_ID,
      project: PROJECT,
      kind: 'release',
      status: 'done',
      exit_code: 1,
      started_at: started + 20,
      finished_at: started + 80,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      parent_job_id: RUN_ID,
      context_meta: null,
      provider: 'claude',
      work_summary: null,
    },
    {
      id: 'continue-owned-review',
      project: PROJECT,
      kind: 'review',
      status: 'done',
      exit_code: 0,
      started_at: started + 25,
      finished_at: started + 35,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'continue-owned-review-session',
      release_id: RELEASE_ID,
      parent_job_id: RELEASE_ID,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review flagged issues.',
      verdict: 'NEEDS ATTENTION',
    },
    {
      id: 'continue-owned-fix',
      project: PROJECT,
      kind: 'fix',
      status: 'done',
      exit_code: 1,
      started_at: started + 40,
      finished_at: started + 70,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: RELEASE_ID,
      parent_job_id: 'continue-owned-review',
      context_meta: null,
      provider: 'claude',
      work_summary: null,
      detail: 'fix step could not resolve the failing review',
    },
  ]
}

async function stubHistoryShell(
  page: Page,
  jobs: () => MockJob[],
  opts: { jobsPaused?: boolean } = {},
): Promise<void> {
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
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 1 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const currentJobs = jobs()
      route.fulfill({ json: { jobs: currentJobs, total: currentJobs.length, pendingReleaseProjects: [] } })
    },
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const currentJobs = jobs()
      route.fulfill({
        json: {
          total: currentJobs.length,
          byKind: { run: 1, release: 1, review: 1, fix: 1 },
          byStatus: { running: 0, done: currentJobs.length, aborted: 0, failed: 2 },
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
    route.fulfill({
      json: { settings: { jobs_paused: opts.jobsPaused ? 'true' : 'false' }, github_owner: '' },
    }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
}

test.describe('History agent-owned failed release continue action', () => {
  test('run row offers "Continue release" targeting the owned release id', async ({ page }) => {
    await stubHistoryShell(page, agentOwnedFailedReleaseJobs)

    let releaseBody: Record<string, unknown> | null = null
    await page.route(`**/api/projects/by-project/${PROJECT}/release`, (route: Route) => {
      releaseBody = route.request().postDataJSON() as Record<string, unknown>
      route.fulfill({ json: { ok: true, release_job_id: 'queued-continue-release' } })
    })

    await page.goto(`/project/${PROJECT}/history`)

    const runRow = page.getByRole('button').filter({ hasText: RUN_PROMPT }).first()
    await expect(runRow).toBeVisible({ timeout: 8_000 })

    // Failed-with-children release is recoverable: "Continue release", not "Retry release".
    const continueBtn = runRow.getByRole('button', { name: 'Continue release' })
    await expect(continueBtn).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByRole('button', { name: 'Retry release' })).toHaveCount(0)
    // The failing child is a `fix` step (not commit/push), so no step-retry button.
    await expect(runRow.getByRole('button', { name: /Retry (push|commit)/ })).toHaveCount(0)

    await continueBtn.click()

    await expect.poll(() => releaseBody, { timeout: 8_000 }).not.toBeNull()
    expect(releaseBody).toMatchObject({ queue_if_blocked: true, source_job_id: RELEASE_ID })
  })

  test('"Continue release" is disabled while jobs are globally paused', async ({ page }) => {
    await stubHistoryShell(page, agentOwnedFailedReleaseJobs, { jobsPaused: true })

    await page.goto(`/project/${PROJECT}/history`)

    const runRow = page.getByRole('button').filter({ hasText: RUN_PROMPT }).first()
    await expect(runRow).toBeVisible({ timeout: 8_000 })

    const continueBtn = runRow.getByRole('button', { name: 'Continue release' })
    await expect(continueBtn).toBeVisible({ timeout: 8_000 })
    await expect(continueBtn).toBeDisabled()
  })
})
