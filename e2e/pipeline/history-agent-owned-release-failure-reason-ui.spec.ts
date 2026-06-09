import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// When an ordinary terminal run auto-triggers a release, the History tab nests
// that release under the run row. If the release fails in a child step, the
// parent run row should surface the concrete step detail, not just a generic
// "release failed" chip.

const PROJECT = 'history-agent-owned-release-failure-reason-ui'
const RUN_ID = 'owned-release-run'
const RELEASE_ID = 'owned-release-release'
const PUSH_DETAIL = 'fatal: pre-push hook rejected the generated commit'

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
      session_id: 'owned-release-session',
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
      finished_at: started + 70,
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
      id: 'owned-release-review',
      project: PROJECT,
      kind: 'review',
      status: 'done',
      exit_code: 0,
      started_at: started + 25,
      finished_at: started + 35,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: 'owned-release-review-session',
      release_id: RELEASE_ID,
      parent_job_id: RELEASE_ID,
      context_meta: null,
      provider: 'claude',
      work_summary: 'Review passed.',
      verdict: 'LGTM',
    },
    {
      id: 'owned-release-commit',
      project: PROJECT,
      kind: 'commit',
      status: 'done',
      exit_code: 0,
      started_at: started + 40,
      finished_at: started + 50,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: RELEASE_ID,
      parent_job_id: 'owned-release-review',
      context_meta: null,
      provider: 'claude',
      work_summary: 'Commit created.',
    },
    {
      id: 'owned-release-push',
      project: PROJECT,
      kind: 'push',
      status: 'done',
      exit_code: 1,
      started_at: started + 55,
      finished_at: started + 65,
      pid: 0,
      log_path: '',
      seen: true,
      session_id: null,
      release_id: RELEASE_ID,
      parent_job_id: 'owned-release-commit',
      context_meta: null,
      provider: 'claude',
      work_summary: null,
      detail: PUSH_DETAIL,
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
          byKind: { run: 1, release: 1, review: 1, commit: 1, push: 1 },
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

test.describe('History agent-owned release failure reason', () => {
  test('run row surfaces the nested failed release step detail as its reason', async ({ page }) => {
    await stubHistoryShell(page, agentOwnedFailedReleaseJobs)

    await page.goto(`/project/${PROJECT}/history`)

    const runRow = page.getByRole('button').filter({ hasText: 'Investigate and release the change.' }).first()
    await expect(runRow).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByText('release failed')).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByText(PUSH_DETAIL)).toBeVisible({ timeout: 8_000 })

    const reason = runRow.locator('div', { hasText: 'reason' }).last()
    await expect(reason).toContainText('reason')
  })
})
