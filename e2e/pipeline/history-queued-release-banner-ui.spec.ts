import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'history-queued-release-banner'

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

async function stubHistoryShell(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [makeTask()],
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
    route.fulfill({
      json: { branch: 'master', defaultBranch: 'master', commitsAhead: null },
    }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  )
  await page.route(
    (url) =>
      url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
}

test.describe('History queued release banner live polling', () => {
  test('history tab shows the queued release banner when pendingReleaseProjects gains the project', async ({
    page,
  }) => {
    let queued = false

    await stubHistoryShell(page)
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [],
            pendingReleaseProjects: queued ? [PROJECT] : [],
          },
        }),
    )

    await page.goto(`/project/${PROJECT}/history`)

    const banner = page.getByRole('link', {
      name: /Release queued — will fire automatically/i,
    })
    await expect(banner).toHaveCount(0, { timeout: 8_000 })

    queued = true

    await expect(banner).toBeVisible({ timeout: 12_000 })
    await expect(banner).toHaveAttribute('href', `/pipeline?project=${PROJECT}`)
  })

  test('history tab clears the queued release banner when pendingReleaseProjects no longer includes the project', async ({
    page,
  }) => {
    let queued = true

    await stubHistoryShell(page)
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [],
            pendingReleaseProjects: queued ? [PROJECT] : [],
          },
        }),
    )

    await page.goto(`/project/${PROJECT}/history`)

    const banner = page.getByRole('link', {
      name: /Release queued — will fire automatically/i,
    })
    await expect(banner).toBeVisible({ timeout: 8_000 })

    queued = false

    await expect(banner).toHaveCount(0, { timeout: 12_000 })
  })
})
