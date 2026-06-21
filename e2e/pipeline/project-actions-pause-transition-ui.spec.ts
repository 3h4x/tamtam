import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'project-actions-pause-transition-ui'
const FEATURE_BRANCH = 'feature/live-pause-transition'

type Scenario = 'create-pr' | 'push-to-pr'

function now() {
  return Math.floor(Date.now() / 1000)
}

function makeTask(scenario: Scenario) {
  const changes = scenario === 'push-to-pr' ? 3 : 0
  const unpushed = scenario === 'create-pr' ? 0 : 0

  return {
    id: `${PROJECT}-${scenario}`,
    project: PROJECT,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${PROJECT}`,
    fires_at: '',
    sync: true,
    changes,
    unpushed,
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

async function stubProjectRoutes(
  page: Page,
  opts: {
    scenario: Scenario
    getJobsPaused: () => boolean
  },
): Promise<void> {
  const issueSummary =
    opts.scenario === 'push-to-pr'
      ? {
          repo: 'test/repo',
          prs: [],
          issues: [],
          prCount: 1,
          issueCount: 0,
          openPrBranches: [{ branch: FEATURE_BRANCH, number: 42 }],
          error: null,
          cached: false,
          cachedAt: now(),
        }
      : {
          repo: 'test/repo',
          prs: [],
          issues: [],
          prCount: 0,
          issueCount: 0,
          openPrBranches: [],
          error: null,
          cached: false,
          cachedAt: now(),
        }

  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(opts.scenario)], priorities: [], issueCounts: {} },
    }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: opts.getJobsPaused() ? 'true' : 'false' },
        github_owner: '',
      },
    }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  )
  await page.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  )
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({
      json: {
        project: PROJECT,
        test_command: '',
        release_timeout_minutes: null,
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
        website: '',
        qa_url: '',
      },
    }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({
      json: { branch: FEATURE_BRANCH, defaultBranch: 'master', commitsAhead: 2 },
    }),
  )
  await page.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') === '1',
    (route: Route) => route.fulfill({ json: issueSummary }),
  )
  await page.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') !== '1',
    (route: Route) => route.fulfill({ json: issueSummary }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) =>
    route.fulfill({
      json: {
        files: [],
        totalFiles: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        branch: FEATURE_BRANCH,
        behind: 0,
        ahead: 2,
      },
    }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
}

test.describe('Project header action buttons respond to live jobs_paused transitions', () => {
  test('Create PR disables in place when jobs_paused flips on', async ({ page }) => {
    let jobsPaused = false

    await stubProjectRoutes(page, {
      scenario: 'create-pr',
      getJobsPaused: () => jobsPaused,
    })

    await page.goto(`/project/${PROJECT}/issues`)

    const createPrButton = page.getByRole('button', { name: 'Create PR' })
    await expect(createPrButton).toBeVisible({ timeout: 8_000 })
    await expect(createPrButton).toBeEnabled()
    await expect(createPrButton).toHaveAttribute(
      'title',
      `Create pull request for branch ${FEATURE_BRANCH}`,
    )

    jobsPaused = true

    await expect(createPrButton).toBeDisabled({ timeout: 12_000 })
    await expect(createPrButton).toHaveAttribute(
      'title',
      'Jobs are paused globally. Resume jobs to create a PR.',
      { timeout: 12_000 },
    )
    await expect(createPrButton).toHaveText('Create PR')
  })

  test('Push to PR disables in place when jobs_paused flips on without losing the PR target', async ({
    page,
  }) => {
    let jobsPaused = false

    await stubProjectRoutes(page, {
      scenario: 'push-to-pr',
      getJobsPaused: () => jobsPaused,
    })

    await page.goto(`/project/${PROJECT}/issues`)

    const pushToPrButton = page.getByRole('button', { name: 'Push to PR #42' })
    await expect(pushToPrButton).toBeVisible({ timeout: 8_000 })
    await expect(pushToPrButton).toBeEnabled()
    await expect(pushToPrButton).toHaveAttribute('title', /Stage 3 changes/i)
    await expect(pushToPrButton).toHaveAttribute('title', /Skips test \+ review/i)

    jobsPaused = true

    await expect(pushToPrButton).toBeDisabled({ timeout: 12_000 })
    await expect(pushToPrButton).toHaveAttribute(
      'title',
      'Jobs are paused globally. Resume jobs to start a push.',
      { timeout: 12_000 },
    )
    await expect(pushToPrButton).toHaveText('Push to PR #42')
  })
})
