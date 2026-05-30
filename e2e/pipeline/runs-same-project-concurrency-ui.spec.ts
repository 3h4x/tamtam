import { test, expect } from '@playwright/test'
import type { Route } from '@playwright/test'

const PROJECT = 'runs-same-project-concurrency'

const now = () => Math.floor(Date.now() / 1000)

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

function makeRunJob(phase: 0 | 1 | 2) {
  const running = phase < 2
  return {
    id: 'same-project-chat-run',
    project: PROJECT,
    kind: 'run',
    prompt: 'Investigate lint noise while the release keeps shipping',
    user_prompt: 'Investigate lint noise while the release keeps shipping',
    status: running ? 'running' : 'done',
    exit_code: running ? null : 0,
    started_at: now() - 120,
    finished_at: running ? null : now() - 6,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: 'sess-same-project-chat-run',
    work_summary: running
      ? 'Triaging a separate terminal run without blocking the release'
      : 'Terminal run completed after the release finished',
  }
}

function makeReleaseJob(phase: 0 | 1 | 2) {
  const running = phase === 0
  return {
    id: 'same-project-release',
    project: PROJECT,
    kind: 'release',
    prompt: null,
    status: running ? 'running' : 'done',
    exit_code: running ? null : 0,
    started_at: now() - 90,
    finished_at: running ? null : now() - 20,
    pid: 0,
    log_path: '',
    seen: true,
    work_summary: null,
  }
}

function makeReviewJob(phase: 0 | 1 | 2) {
  const running = phase === 0
  return {
    id: 'same-project-release-review',
    project: PROJECT,
    kind: 'review',
    prompt: 'Review the pending release while the chat run continues',
    status: running ? 'running' : 'done',
    exit_code: running ? null : 0,
    started_at: now() - 80,
    finished_at: running ? null : now() - 35,
    pid: 0,
    log_path: '',
    seen: true,
    release_id: 'same-project-release',
    parent_job_id: 'same-project-release',
    verdict: running ? null : 'LGTM',
  }
}

function makeJobs(phase: 0 | 1 | 2) {
  return [
    makeRunJob(phase),
    makeReleaseJob(phase),
    makeReviewJob(phase),
  ]
}

function runningRows(page: import('@playwright/test').Page) {
  return page.getByRole('button').filter({ has: page.locator('[aria-label="running"]') })
}

test.describe('Global runs page same-project concurrency', () => {
  test('release and ordinary run on the same project keep independent live state as each finishes', async ({
    page,
  }) => {
    let phase: 0 | 1 | 2 = 0
    const currentJobs = () => makeJobs(phase)

    await page.route('**/api/projects', (route: Route) =>
      route.fulfill({
        json: {
          tasks: [makeTask(PROJECT)],
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
      (route: Route) => {
        const jobs = currentJobs()
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
      (route: Route) => {
        const jobs = currentJobs()
        const running = jobs.filter((job) => job.status === 'running').length
        const failed = jobs.filter((job) => job.exit_code !== null && job.exit_code !== 0).length
        route.fulfill({
          json: {
            total: jobs.length,
            byKind: { run: 1, release: 1, review: 1 },
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
      route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
    )

    await page.goto(`/project/${PROJECT}/history`)

    const releaseRow = page.getByRole('button').filter({ hasText: 'Release pipeline' }).first()
    const runRow = page.getByRole('button')
      .filter({ hasText: 'Investigate lint noise while the release keeps shipping' })
      .first()

    await expect(releaseRow).toBeVisible({ timeout: 8_000 })
    await expect(runRow).toBeVisible({ timeout: 8_000 })
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(runningRows(page)).toHaveCount(2, { timeout: 8_000 })
    await expect(page.getByText('showing 2 of 3')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 8_000 })
    await expect(runRow.getByText('Triaging a separate terminal run without blocking the release')).toBeVisible()

    phase = 1

    await expect(releaseRow.locator('[aria-label="done"]')).toBeVisible({ timeout: 12_000 })
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(runningRows(page)).toHaveCount(1, { timeout: 12_000 })
    await expect(runRow.getByText('running', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('showing 2 of 3')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 20_000 })

    phase = 2

    await expect(runRow.locator('[aria-label="done"]')).toBeVisible({ timeout: 12_000 })
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(runningRows(page)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByText('showing 2 of 3')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 20_000 })
    await expect(
      runRow.getByText('Terminal run completed after the release finished'),
    ).toBeVisible({ timeout: 12_000 })
  })
})
