import { test, expect } from '@playwright/test'
import type { BrowserContext, Route } from '@playwright/test'

// Exercises the per-run "Continue" button gating + click flow in
// components/ProjectRunsTab.tsx (continueTargetFor / continueRun), which had
// no e2e coverage. Continue is offered only on a done/aborted run|agent row
// that still has a resumable session, finished within CONTINUE_MAX_AGE_MS
// (30 min), AND either exited non-zero OR the local-LLM outcome classifier
// flagged it needs_continue / asked_question. Clicking POSTs to
// /api/jobs/<id>/continue and re-loads the runs list; the button is disabled
// (with an explanatory title) when jobs are globally paused.
//
// All state is page.route()-mocked — no shim/global-setup registration needed
// for a pure render+click surface (see run-outcome-verdict-chip-ui.spec.ts).

const PROJECT = 'runs-continue-button'

const now = () => Math.floor(Date.now() / 1000)

const FAILED_PROMPT = 'Failed run — exited non-zero, recent, resumable.'
const NEEDS_PROMPT = 'Needs-continue run — clean exit but classifier wants more.'
const CLEAN_PROMPT = 'Clean run — exit 0 and classifier said done.'
const STALE_PROMPT = 'Stale run — failed but finished over 30 minutes ago.'

function outcomeMeta(verdict: string) {
  return JSON.stringify({ outcomeClassification: { verdict } })
}

function runJob(
  id: string,
  prompt: string,
  opts: { exitCode: number; finishedAgo: number; contextMeta?: string | null },
) {
  return {
    id,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: opts.exitCode,
    started_at: now() - opts.finishedAgo - 30,
    finished_at: now() - opts.finishedAgo,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: id,
    user_prompt: prompt,
    prompt,
    context_meta: opts.contextMeta ?? null,
    provider: 'claude',
    work_summary: null,
    prompt_bytes: 1_000,
  }
}

function jobs() {
  return [
    // Recent, non-zero exit -> Continue offered.
    runJob('continue-failed', FAILED_PROMPT, { exitCode: 1, finishedAgo: 60 }),
    // Recent, clean exit but classifier wants continue -> Continue offered.
    runJob('continue-needs', NEEDS_PROMPT, {
      exitCode: 0,
      finishedAgo: 60,
      contextMeta: outcomeMeta('needs_continue'),
    }),
    // Clean exit, classifier said done -> NO Continue.
    runJob('clean-done', CLEAN_PROMPT, {
      exitCode: 0,
      finishedAgo: 60,
      contextMeta: outcomeMeta('done'),
    }),
    // Failed but stale (> 30 min) -> NO Continue (age gate).
    runJob('stale-failed', STALE_PROMPT, { exitCode: 1, finishedAgo: 60 * 60 }),
  ]
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

async function stubRoutes(context: BrowserContext, opts: { jobsPaused?: boolean } = {}): Promise<void> {
  await context.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  )
  await context.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: { settings: { jobs_paused: opts.jobsPaused ? 'true' : 'false' }, github_owner: '' },
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
  await context.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: jobs(), total: jobs().length, pendingReleaseProjects: [] } }),
  )
  await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          total: 4,
          byKind: { run: 4 },
          byStatus: { running: 0, done: 4, aborted: 0, failed: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
  )
}

function rowFor(page: import('@playwright/test').Page, prompt: string) {
  return page.getByRole('button').filter({ hasText: prompt }).first()
}

test.describe('ProjectRunsTab Continue button', () => {
  test('offers Continue only on resumable, recent, unfinished runs', async ({ page }) => {
    await stubRoutes(page.context())
    await page.goto(`/project/${PROJECT}/history`)

    const failedRow = rowFor(page, FAILED_PROMPT)
    const needsRow = rowFor(page, NEEDS_PROMPT)
    const cleanRow = rowFor(page, CLEAN_PROMPT)
    const staleRow = rowFor(page, STALE_PROMPT)

    await expect(failedRow).toBeVisible({ timeout: 8_000 })
    await expect(needsRow).toBeVisible({ timeout: 8_000 })
    await expect(cleanRow).toBeVisible({ timeout: 8_000 })
    await expect(staleRow).toBeVisible({ timeout: 8_000 })

    // Non-zero exit, recent -> Continue present and enabled.
    const failedContinue = failedRow.getByRole('button', { name: 'Continue', exact: true })
    await expect(failedContinue).toBeVisible({ timeout: 8_000 })
    await expect(failedContinue).toBeEnabled()

    // Clean exit but classifier flagged needs_continue -> Continue present.
    await expect(needsRow.getByRole('button', { name: 'Continue', exact: true })).toBeVisible({
      timeout: 8_000,
    })

    // Clean exit, classifier said done -> NO Continue.
    await expect(cleanRow.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)

    // Failed but finished over the 30-min resume window -> NO Continue.
    await expect(staleRow.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)
  })

  test('clicking Continue POSTs to the continue endpoint and reloads', async ({ page }) => {
    await stubRoutes(page.context())
    let continueCalls = 0
    await page.context().route(
      (url) => url.pathname === '/api/jobs/continue-failed/continue',
      (route: Route) => {
        continueCalls += 1
        return route.fulfill({
          json: {
            status: 'continued',
            job_id: 'continue-failed-2',
            resumed_session_id: 'continue-failed',
            resumed_from: 'continue-failed',
          },
        })
      },
    )

    await page.goto(`/project/${PROJECT}/history`)

    const failedRow = rowFor(page, FAILED_PROMPT)
    const continueBtn = failedRow.getByRole('button', { name: 'Continue', exact: true })
    await expect(continueBtn).toBeVisible({ timeout: 8_000 })

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.method() === 'POST' &&
          req.url().includes('/api/jobs/continue-failed/continue'),
        { timeout: 8_000 },
      ),
      continueBtn.click(),
    ])

    expect(request.method()).toBe('POST')
    expect(continueCalls).toBeGreaterThanOrEqual(1)
  })

  test('disables Continue with a paused-jobs hint when jobs are globally paused', async ({ page }) => {
    await stubRoutes(page.context(), { jobsPaused: true })
    await page.goto(`/project/${PROJECT}/history`)

    const failedRow = rowFor(page, FAILED_PROMPT)
    const continueBtn = failedRow.getByRole('button', { name: 'Continue', exact: true })
    await expect(continueBtn).toBeVisible({ timeout: 8_000 })
    await expect(continueBtn).toBeDisabled()
    await expect(continueBtn).toHaveAttribute(
      'title',
      'Jobs are paused globally. Resume jobs to continue this run.',
    )
  })
})
