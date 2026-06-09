import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'history-retry-push-ui'
const RELEASE_ID = 'history-retry-push-release'

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

function failedPushReleaseJobs(): MockJob[] {
  const releaseStarted = now() - 80
  return [
    {
      id: RELEASE_ID,
      project: PROJECT,
      kind: 'release',
      status: 'done',
      exit_code: 1,
      started_at: releaseStarted,
      finished_at: now() - 10,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Release failed at push.',
    },
    {
      id: 'history-retry-push-review',
      project: PROJECT,
      kind: 'review',
      status: 'done',
      exit_code: 0,
      started_at: releaseStarted + 10,
      finished_at: releaseStarted + 20,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'history-retry-push-review-session',
      release_id: RELEASE_ID,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review passed.',
      verdict: 'LGTM',
    },
    {
      id: 'history-retry-push-commit',
      project: PROJECT,
      kind: 'commit',
      status: 'done',
      exit_code: 0,
      started_at: releaseStarted + 25,
      finished_at: releaseStarted + 35,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: RELEASE_ID,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Commit created.',
    },
    {
      id: 'history-retry-push-failed',
      project: PROJECT,
      kind: 'push',
      status: 'done',
      exit_code: 1,
      started_at: releaseStarted + 40,
      finished_at: releaseStarted + 50,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: RELEASE_ID,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Push failed: remote rejected.',
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
          byKind: { release: 1, review: 1, commit: 1, push: 1 },
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
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
}

test.describe('History retry push action', () => {
  test('failed push release shows a step-specific retry button and retries push without recommitting', async ({
    page,
  }) => {
    await stubHistoryShell(page, failedPushReleaseJobs)

    let retryBody: unknown = null
    await page.route(`**/api/projects/by-project/${PROJECT}/push`, async (route: Route) => {
      retryBody = route.request().postDataJSON()
      await route.fulfill({ json: { status: 'started', job_id: 'history-retry-push-new-job' } })
    })

    await page.goto(`/project/${PROJECT}/history`)

    const releaseRow = page.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
    await expect(releaseRow).toBeVisible({ timeout: 8_000 })
    await expect(releaseRow.getByText('release failed')).toBeVisible({ timeout: 8_000 })
    await expect(releaseRow.getByText(/push\s+\u27171/)).toBeVisible({ timeout: 8_000 })

    const retry = releaseRow.getByRole('button', { name: 'Retry push' })
    await expect(retry).toBeVisible({ timeout: 8_000 })
    await expect(retry).toHaveAttribute('title', 'Retry the failed push step for this release')
    await expect(releaseRow.getByRole('button', { name: 'Retry commit' })).toHaveCount(0)

    await retry.click()

    await expect.poll(() => retryBody).toEqual({ release_id: RELEASE_ID })
    await expect(retry).toBeEnabled({ timeout: 8_000 })
  })
})
