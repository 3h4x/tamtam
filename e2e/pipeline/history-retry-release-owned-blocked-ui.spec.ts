import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Covers the "Retry release" button on an AGENT-OWNED release row.
// When an ordinary run auto-triggers a release, the release is nested under the
// run row (chainedChildren), and the run row carries the release's actions
// (releaseActionsFor → ownedRelease branch in ProjectRunsTab). A blocked
// release (exit !== 0, NO children) renders "Retry release" on that run row.
// The top-level release-row variant is covered by
// history-retry-release-blocked-ui.spec.ts.

const PROJECT = 'history-retry-release-owned-blocked-ui'
const RUN_ID = 'owned-blocked-run'
const RELEASE_ID = 'owned-blocked-release'

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
  parent_job_id?: string | null
  release_id?: string | null
  context_meta: string | null
  provider: string
  work_summary: string | null
  verdict?: string | null
  user_prompt?: string
  prompt?: string
}

function makeTask() {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
    launchctl: 'stopped',
    path: `/tmp/${PROJECT}`,
    fires_at: '',
    sync: true,
    changes: 2,
    unpushed: 0,
    reviewed: false,
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

// A run that auto-triggered a release which exited non-zero with NO children
// — the agent-owned "blocked" case. ownedRelease.children.length === 0 derives
// outcomeStatus = 'blocked', so the run row renders "Retry release".
function ownedBlockedReleaseJobs(): MockJob[] {
  const started = now() - 100
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
      session_id: 'owned-blocked-session',
      context_meta: null,
      provider: 'claude',
      work_summary: null,
      user_prompt: 'Investigate and release the change.',
      prompt: 'Investigate and release the change.',
    },
    {
      id: RELEASE_ID,
      project: PROJECT,
      kind: 'release',
      status: 'done',
      exit_code: 1,
      started_at: started + 20,
      finished_at: started + 30,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      parent_job_id: RUN_ID,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Release blocked: another job is running.',
    },
  ]
}

async function stubHistoryShell(page: Page, jobs: () => MockJob[]): Promise<void> {
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
          byKind: { run: 1, release: 1 },
          byStatus: { running: 0, done: currentJobs.length, aborted: 0, failed: 1 },
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
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
}

test.describe('History retry release (agent-owned, blocked)', () => {
  test('agent-owned blocked release shows "Retry release" on the run row and posts the correct body', async ({
    page,
  }) => {
    await stubHistoryShell(page, ownedBlockedReleaseJobs)

    let retryBody: unknown = null
    await page.route(`**/api/projects/by-project/${PROJECT}/release`, async (route: Route) => {
      retryBody = route.request().postDataJSON()
      await route.fulfill({ json: { status: 'started', job_id: 'owned-blocked-new-release' } })
    })

    await page.goto(`/project/${PROJECT}/history`)

    // The run row (not a release row) carries the owned release's actions.
    const runRow = page.getByRole('button').filter({ hasText: 'Investigate and release the change.' }).first()
    await expect(runRow).toBeVisible({ timeout: 8_000 })

    // Blocked owned release: button must read "Retry release", not "Continue release".
    const retryBtn = runRow.getByRole('button', { name: 'Retry release' })
    await expect(retryBtn).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByRole('button', { name: 'Continue release' })).toHaveCount(0)

    await retryBtn.click()

    // The retry must target the OWNED release id, not the parent run id.
    await expect.poll(() => retryBody, { timeout: 8_000 }).toEqual({
      queue_if_blocked: true,
      source_job_id: RELEASE_ID,
    })
    await expect(retryBtn).toBeEnabled({ timeout: 8_000 })
  })

  test('agent-owned blocked release button is disabled when jobs are paused', async ({ page }) => {
    await stubHistoryShell(page, ownedBlockedReleaseJobs)

    await page.route('**/api/settings', (route: Route) =>
      route.fulfill({ json: { settings: { jobs_paused: 'true' }, github_owner: '' } }),
    )

    await page.goto(`/project/${PROJECT}/history`)

    const runRow = page.getByRole('button').filter({ hasText: 'Investigate and release the change.' }).first()
    await expect(runRow).toBeVisible({ timeout: 8_000 })

    const retryBtn = runRow.getByRole('button', { name: 'Retry release' })
    await expect(retryBtn).toBeVisible({ timeout: 8_000 })
    await expect(retryBtn).toBeDisabled()
    await expect(retryBtn).toHaveAttribute('title', 'Jobs are paused globally. Resume jobs to start a release.')
  })
})
