import { test, expect } from '@playwright/test'
import type { BrowserContext, Route } from '@playwright/test'

// Verifies that the Continue and Rerun action buttons on the project history
// tab respond dynamically when jobs_paused flips on, without a page reload.
//
// Context: ProjectDetailPage polls /api/settings every 5 s and passes
// jobsPaused down to ProjectRunsTab as a prop. When it flips from false to
// true the Continue button must disable (with the paused title hint) and the
// Rerun button must disappear — all without a page.reload(). The static
// (starts-paused) case is already covered by runs-continue-button-ui.spec.ts
// and runs-rerun-button-ui.spec.ts; this file adds the LIVE transition.

const PROJECT = 'history-action-pause-transition'
const now = () => Math.floor(Date.now() / 1000)

const FAILED_PROMPT = 'Dynamic pause test — exits non-zero so Continue is offered.'
const DONE_PROMPT = 'Finished clean run — always shows Rerun.'

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

function failedRunJob(id: string, prompt: string) {
  return {
    id,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: 1,
    started_at: now() - 90,
    finished_at: now() - 60,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: id,
    user_prompt: prompt,
    prompt,
    context_meta: null,
    provider: 'claude',
    work_summary: null,
    prompt_bytes: 1_000,
  }
}

function doneRunJob(id: string, prompt: string) {
  return {
    id,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: 0,
    started_at: now() - 90,
    finished_at: now() - 60,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: id,
    user_prompt: prompt,
    prompt,
    context_meta: null,
    provider: 'claude',
    work_summary: null,
    prompt_bytes: 1_000,
  }
}

async function stubRoutes(context: BrowserContext, getJobsPaused: () => boolean): Promise<void> {
  await context.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  )
  await context.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: { settings: { jobs_paused: getJobsPaused() ? 'true' : 'false' }, github_owner: '' },
    }),
  )
  await context.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  )
  await context.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  )
  await context.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await context.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await context.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  )
  await context.route(
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
  await context.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') !== '1',
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  )
  await context.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  const jobsList = [
    failedRunJob('pause-transition-failed', FAILED_PROMPT),
    doneRunJob('pause-transition-done', DONE_PROMPT),
  ]
  await context.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: jobsList, total: 2, pendingReleaseProjects: [] } }),
  )
  await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          total: 2,
          byKind: { run: 2 },
          byStatus: { running: 0, done: 2, aborted: 0, failed: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
  )
}

test.describe('History tab action buttons respond to live jobs_paused transition', () => {
  // ─── Test 1: Continue button disables when jobs_paused flips on ─────────────
  //
  // ProjectDetailPage polls /api/settings every 5 s. When jobs_paused switches
  // from false to true the Continue button must disable and show the paused
  // hint, without the user reloading the page.

  test('Continue button disables without reload when jobs_paused flips on', async ({ page }) => {
    let jobsPaused = false

    await stubRoutes(page.context(), () => jobsPaused)

    await page.goto(`/project/${PROJECT}/history`)

    const failedRow = page.getByRole('button').filter({ hasText: FAILED_PROMPT }).first()
    await expect(failedRow).toBeVisible({ timeout: 8_000 })

    const continueBtn = failedRow.getByRole('button', { name: 'Continue', exact: true })
    await expect(continueBtn).toBeVisible({ timeout: 8_000 })
    await expect(continueBtn).toBeEnabled()

    // Flip the flag — the next /api/settings poll will return jobs_paused=true.
    jobsPaused = true

    // ProjectDetailPage polls settings every 5 s → button must disable within 12 s.
    await expect(continueBtn).toBeDisabled({ timeout: 12_000 })
    await expect(continueBtn).toHaveAttribute(
      'title',
      'Jobs are paused globally. Resume jobs to continue this run.',
      { timeout: 12_000 },
    )
  })

  // ─── Test 2: Rerun button disappears when jobs_paused flips on ──────────────
  //
  // Rerun is hidden entirely (not just disabled) when jobs are globally paused.
  // Verify the button disappears after the settings poll picks up the new flag.

  test('Rerun button disappears without reload when jobs_paused flips on', async ({ page }) => {
    let jobsPaused = false

    await stubRoutes(page.context(), () => jobsPaused)

    await page.goto(`/project/${PROJECT}/history`)

    const doneRow = page.getByRole('button').filter({ hasText: DONE_PROMPT }).first()
    await expect(doneRow).toBeVisible({ timeout: 8_000 })

    const rerunBtn = doneRow.getByRole('button', { name: 'Rerun', exact: true })
    await expect(rerunBtn).toBeVisible({ timeout: 8_000 })
    await expect(rerunBtn).toBeEnabled()

    // Flip the flag — the next /api/settings poll will return jobs_paused=true.
    jobsPaused = true

    // Rerun is hidden entirely when paused; expect it to vanish within 12 s.
    await expect(rerunBtn).toHaveCount(0, { timeout: 12_000 })
  })

  // ─── Test 3: Both buttons re-enable when jobs_paused flips back off ─────────
  //
  // When the administrator resumes jobs (jobs_paused = false), Continue must
  // re-enable and Rerun must reappear — still without a page reload.

  test('Continue re-enables and Rerun reappears when jobs_paused flips back off', async ({ page }) => {
    let jobsPaused = true

    await stubRoutes(page.context(), () => jobsPaused)

    await page.goto(`/project/${PROJECT}/history`)

    const failedRow = page.getByRole('button').filter({ hasText: FAILED_PROMPT }).first()
    const doneRow = page.getByRole('button').filter({ hasText: DONE_PROMPT }).first()
    await expect(failedRow).toBeVisible({ timeout: 8_000 })
    await expect(doneRow).toBeVisible({ timeout: 8_000 })

    // Paused state: Continue is disabled, Rerun is absent.
    const continueBtn = failedRow.getByRole('button', { name: 'Continue', exact: true })
    await expect(continueBtn).toBeVisible({ timeout: 8_000 })
    await expect(continueBtn).toBeDisabled()
    await expect(doneRow.getByRole('button', { name: 'Rerun', exact: true })).toHaveCount(0)

    // Resume jobs — next poll returns jobs_paused=false.
    jobsPaused = false

    await expect(continueBtn).toBeEnabled({ timeout: 12_000 })
    await expect(doneRow.getByRole('button', { name: 'Rerun', exact: true })).toBeVisible({
      timeout: 12_000,
    })
  })
})
