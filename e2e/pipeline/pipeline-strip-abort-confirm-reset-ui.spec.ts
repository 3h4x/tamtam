import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Pure page.route() UI spec — this project is intentionally NOT in global-setup's
// PROJECTS list; every shell request the terminal tab makes is stubbed below.
//
// Gap covered: PipelineStrip's "abort?" confirm prompt is local component state.
// When the strip stays mounted across a release transition (release A finishes
// and release B starts in place via the 5s jobs poll), a confirm prompt the
// operator opened against release A must NOT carry over to release B. This spec
// opens the confirm prompt on release A, lets the live poll swap in release B,
// and asserts the new release shows the plain "abort" control — never a stale
// "abort?" prompt nobody opened. Without the reset effect the prompt persists.

const PROJECT = 'pipeline-strip-abort-confirm-reset'

const now = () => Math.floor(Date.now() / 1000)

type MockJob = {
  id: string
  project: string
  kind: string
  status: 'running' | 'done'
  exit_code: number | null
  verdict?: string | null
  started_at: number
  finished_at: number | null
  parent_job_id?: string | null
  release_id?: string | null
  session_id?: string | null
  context_meta?: string | null
  prompt?: string | null
  user_prompt?: string | null
  pid?: number
  log_path?: string
  seen?: boolean
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

function makeProjectConfig() {
  return {
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
  }
}

// Release A in flight: a running review under a running release meta-job.
function releaseAJobs(): MockJob[] {
  return [
    {
      id: 'rel-A',
      project: PROJECT,
      kind: 'release',
      status: 'running',
      exit_code: null,
      started_at: now() - 30,
      finished_at: null,
      session_id: null,
    },
    {
      id: 'rev-A',
      project: PROJECT,
      kind: 'review',
      status: 'running',
      exit_code: null,
      verdict: null,
      started_at: now() - 25,
      finished_at: null,
      parent_job_id: 'rel-A',
      release_id: 'rel-A',
      session_id: 'sess-rev-A',
    },
  ]
}

// Release A finished cleanly; release B has started in place with its own review.
function releaseBJobs(): MockJob[] {
  return [
    {
      id: 'rel-A',
      project: PROJECT,
      kind: 'release',
      status: 'done',
      exit_code: 0,
      started_at: now() - 30,
      finished_at: now() - 6,
      session_id: null,
    },
    {
      id: 'rev-A',
      project: PROJECT,
      kind: 'review',
      status: 'done',
      exit_code: 0,
      verdict: 'LGTM',
      started_at: now() - 25,
      finished_at: now() - 7,
      parent_job_id: 'rel-A',
      release_id: 'rel-A',
      session_id: 'sess-rev-A',
    },
    {
      id: 'rel-B',
      project: PROJECT,
      kind: 'release',
      status: 'running',
      exit_code: null,
      started_at: now() - 3,
      finished_at: null,
      session_id: null,
    },
    {
      id: 'rev-B',
      project: PROJECT,
      kind: 'review',
      status: 'running',
      exit_code: null,
      verdict: null,
      started_at: now() - 2,
      finished_at: null,
      parent_job_id: 'rel-B',
      release_id: 'rel-B',
      session_id: 'sess-rev-B',
    },
  ]
}

async function stubTerminalShell(page: Page, jobsForProject: () => MockJob[]): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  )
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  )
  await page.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') === '1',
    (route: Route) =>
      route.fulfill({
        json: {
          repo: '',
          prCount: 0,
          issueCount: 0,
          openPrBranches: [],
          error: null,
          cached: false,
          cachedAt: now(),
        },
      }),
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
    (route: Route) =>
      route.fulfill({ json: { jobs: jobsForProject(), pendingReleaseProjects: [] } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
}

test.describe('Pipeline strip abort confirm resets across a release transition', () => {
  test('opening the abort confirm on one release does not carry it to the next release', async ({
    page,
  }) => {
    // Mutable source of truth for the jobs poll — flipped mid-test.
    let phase: 'a' | 'b' = 'a'
    await stubTerminalShell(page, () => (phase === 'a' ? releaseAJobs() : releaseBJobs()))

    await page.goto(`/project/${PROJECT}/terminal`)

    const abortButton = page.locator('button[title="Abort the running pipeline"]')
    const confirmYes = page.locator('button[title="Confirm abort"]')
    const traceLink = page.getByRole('link', { name: /trace/i })

    // Release A is in flight: the plain abort affordance is present.
    await expect(abortButton).toBeVisible({ timeout: 8_000 })
    await expect(traceLink).toHaveAttribute('href', /\/release\/rel-A$/, { timeout: 8_000 })

    // Operator opens the confirm prompt against release A.
    await abortButton.click()
    await expect(page.getByText('abort?', { exact: true })).toBeVisible({ timeout: 8_000 })
    await expect(confirmYes).toBeVisible()

    // Release A finishes and release B starts in place; the 5s jobs poll swaps it.
    phase = 'b'

    // Once the strip is tracking release B, the confirm prompt must be gone and
    // the plain abort affordance restored — the new release never inherits the
    // prompt the operator opened against the old one.
    await expect(traceLink).toHaveAttribute('href', /\/release\/rel-B$/, { timeout: 12_000 })
    await expect(page.getByText('abort?', { exact: true })).toHaveCount(0)
    await expect(confirmYes).toHaveCount(0)
    await expect(abortButton).toBeVisible()
  })
})
