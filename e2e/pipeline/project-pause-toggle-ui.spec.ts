import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'project-pause-toggle-ui'

function makeTask(paused = false) {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${PROJECT}`,
    fires_at: '*/15 * * * *',
    paused,
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

function makeProjectConfig(paused = false) {
  return {
    project: PROJECT,
    test_command: '',
    release_timeout_minutes: null,
    detected_test_command: '',
    effective_test_command: '',
    test_cron_enabled: false,
    test_cron_schedule: '',
    auto_commit_enabled: false,
    auto_push_enabled: false,
    auto_pr_merge_enabled: false,
    post_merge_watch_minutes: 0,
    auto_revert_enabled: false,
    release_after_run: false,
    issue_auto_branch: true,
    tests_disabled: true,
    review_disabled: false,
    review_prompt_addendum: '',
    review_prerequisite_command: '',
    fix_prompt_addendum: '',
    commit_style: '',
    website: '',
    qa_url: '',
    dev_server_start_command: '',
    dev_server_stop_command: '',
    dev_server_ready_url: '',
    file_config: [],
    file_config_branch: 'master',
    file_config_is_default_branch: true,
    current_branch: 'master',
    paused,
    last_push_error: null,
    last_push_at: null,
  }
}

async function stubProjectDetail(page: Page) {
  let projectPaused = false
  const patchBodies: Array<Record<string, unknown>> = []

  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(projectPaused)], priorities: [], issueCounts: {} },
    }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false', retrieval_enabled: 'false' }, github_owner: '' } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}`, async (route: Route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fulfill({ status: 404, json: { detail: 'not found' } })
      return
    }
    const body = route.request().postDataJSON() as Record<string, unknown>
    patchBodies.push(body)
    projectPaused = body.paused === true
    await route.fulfill({ json: { status: 'ok', paused: projectPaused } })
  })
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      route.continue()
      return
    }
    route.fulfill({ json: makeProjectConfig(projectPaused) })
  })
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/issues?summary=1`, (route: Route) =>
    route.fulfill({
      json: {
        repo: '',
        prCount: 0,
        issueCount: 0,
        openPrBranches: [],
        error: null,
        cached: true,
        cachedAt: Date.now(),
      },
    }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/agents**', (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
  await page.route(`**/api/projects/${PROJECT}/retrieval/stats`, (route: Route) =>
    route.fulfill({ json: { records: 0, chunks: 0 } }),
  )

  return { patchBodies }
}

test.describe('Project pause toggle', () => {
  test('toggles project paused state and updates the header control without reload', async ({ page }) => {
    const { patchBodies } = await stubProjectDetail(page)
    await page.goto(`/project/${PROJECT}/config`)

    await expect(page.getByLabel('Website')).toBeVisible({ timeout: 8_000 })

    const pauseButton = page.getByRole('button', { name: 'Pause project' })
    await expect(pauseButton).toBeVisible()
    await expect(pauseButton).toHaveAttribute('aria-pressed', 'false')

    const stableUrl = page.url()
    await pauseButton.click()

    const resumeButton = page.getByRole('button', { name: 'Resume project' })
    await expect(resumeButton).toBeVisible({ timeout: 5_000 })
    await expect(resumeButton).toHaveText('Paused')
    await expect(resumeButton).toHaveAttribute('aria-pressed', 'true')
    expect(patchBodies[0]).toEqual({ paused: true })
    await expect(page).toHaveURL(stableUrl)

    await resumeButton.click()

    const pauseAgainButton = page.getByRole('button', { name: 'Pause project' })
    await expect(pauseAgainButton).toBeVisible({ timeout: 5_000 })
    await expect(pauseAgainButton).toHaveText('Pause')
    await expect(pauseAgainButton).toHaveAttribute('aria-pressed', 'false')
    expect(patchBodies[1]).toEqual({ paused: false })
    await expect(page).toHaveURL(stableUrl)
  })
})
