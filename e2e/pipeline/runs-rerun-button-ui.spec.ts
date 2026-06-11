import { test, expect } from '@playwright/test'
import type { BrowserContext, Route } from '@playwright/test'

// Exercises the per-run "Rerun" button gating + click flow in
// components/ProjectRunsTab.tsx (rerunTargetFor / rerunRun). Rerun starts a
// fresh run from a finished entry's saved prompt. It
// is offered on any non-running run|agent|other row that still has a job id —
// crucially regardless of exit code, so a CLEAN done run shows Rerun even
// though it shows no Continue. The gate hides Rerun entirely (not just
// disables it) when the entry is still running, when the row is a pipeline
// vgroup/release bucket, or when jobs are globally paused. Clicking POSTs to
// /api/jobs/<id>/rerun and reloads the runs list.
//
// All state is page.route()-mocked — no shim/global-setup registration needed
// for a pure render+click surface (see runs-continue-button-ui.spec.ts).

const PROJECT = 'runs-rerun-button'

const now = () => Math.floor(Date.now() / 1000)

const CLEAN_PROMPT = 'Clean run — exit 0, finished, should still offer Rerun.'
const FAILED_PROMPT = 'Failed run — exit 1, finished, should offer Rerun.'
const RUNNING_PROMPT = 'Running run — still in flight, no Rerun.'
const AGENT_KIND = 'agent:nightly'

function runJob(
  id: string,
  prompt: string,
  opts: { kind?: string; status?: string; exitCode?: number | null },
) {
  const status = opts.status ?? 'done'
  const running = status === 'running'
  return {
    id,
    project: PROJECT,
    kind: opts.kind ?? 'run',
    status,
    exit_code: running ? null : opts.exitCode ?? 0,
    started_at: now() - 120,
    finished_at: running ? null : now() - 60,
    pid: running ? 1234 : 0,
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

function jobs() {
  return [
    runJob('rerun-clean', CLEAN_PROMPT, { exitCode: 0 }),
    runJob('rerun-failed', FAILED_PROMPT, { exitCode: 1 }),
    runJob('rerun-running', RUNNING_PROMPT, { status: 'running' }),
    runJob('rerun-agent', '', { kind: AGENT_KIND, exitCode: 0 }),
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
  await context.route('**/api/skills', (route: Route) => route.fulfill({ json: { skills: [] } }))
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
          byKind: { run: 3, 'agent:nightly': 1 },
          byStatus: { running: 1, done: 3, aborted: 0, failed: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
  )
}

function rowFor(page: import('@playwright/test').Page, text: string) {
  return page.getByRole('button').filter({ hasText: text }).first()
}

test.describe('ProjectRunsTab Rerun button', () => {
  test('offers Rerun on finished run/agent rows regardless of exit code, but not while running', async ({
    page,
  }) => {
    await stubRoutes(page.context())
    await page.goto(`/project/${PROJECT}/history`)

    const cleanRow = rowFor(page, CLEAN_PROMPT)
    const failedRow = rowFor(page, FAILED_PROMPT)
    const runningRow = rowFor(page, RUNNING_PROMPT)
    const agentRow = rowFor(page, 'nightly')

    await expect(cleanRow).toBeVisible({ timeout: 8_000 })
    await expect(failedRow).toBeVisible({ timeout: 8_000 })
    await expect(runningRow).toBeVisible({ timeout: 8_000 })
    await expect(agentRow).toBeVisible({ timeout: 8_000 })

    // Clean exit, finished -> Rerun present + enabled. (Continue is NOT, since
    // the run exited 0 and the classifier didn't flag it — proves Rerun's gate
    // is independent of exit code.)
    const cleanRerun = cleanRow.getByRole('button', { name: 'Rerun', exact: true })
    await expect(cleanRerun).toBeVisible({ timeout: 8_000 })
    await expect(cleanRerun).toBeEnabled()
    await expect(cleanRow.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)

    // Non-zero exit, finished -> Rerun present.
    await expect(failedRow.getByRole('button', { name: 'Rerun', exact: true })).toBeVisible({
      timeout: 8_000,
    })

    // Agent run, finished -> Rerun present (bucket 'agent' is eligible).
    await expect(agentRow.getByRole('button', { name: 'Rerun', exact: true })).toBeVisible({
      timeout: 8_000,
    })

    // Still running -> NO Rerun (status gate).
    await expect(runningRow.getByRole('button', { name: 'Rerun', exact: true })).toHaveCount(0)
  })

  test('clicking Rerun POSTs to the rerun endpoint and reloads', async ({ page }) => {
    await stubRoutes(page.context())
    let rerunCalls = 0
    await page.context().route(
      (url) => url.pathname === '/api/jobs/rerun-clean/rerun',
      (route: Route) => {
        rerunCalls += 1
        return route.fulfill({ json: { status: 'started', job_id: 'rerun-clean-2' } })
      },
    )

    await page.goto(`/project/${PROJECT}/history`)

    const cleanRow = rowFor(page, CLEAN_PROMPT)
    const rerunBtn = cleanRow.getByRole('button', { name: 'Rerun', exact: true })
    await expect(rerunBtn).toBeVisible({ timeout: 8_000 })

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) => req.method() === 'POST' && req.url().includes('/api/jobs/rerun-clean/rerun'),
        { timeout: 8_000 },
      ),
      rerunBtn.click(),
    ])

    expect(request.method()).toBe('POST')
    expect(rerunCalls).toBeGreaterThanOrEqual(1)
  })

  test('hides Rerun entirely when jobs are globally paused', async ({ page }) => {
    await stubRoutes(page.context(), { jobsPaused: true })
    await page.goto(`/project/${PROJECT}/history`)

    const cleanRow = rowFor(page, CLEAN_PROMPT)
    await expect(cleanRow).toBeVisible({ timeout: 8_000 })

    // Paused makes rerunTargetFor() return null, so the button is not rendered
    // at all — distinct from Continue, which renders disabled with a hint.
    await expect(cleanRow.getByRole('button', { name: 'Rerun', exact: true })).toHaveCount(0)
  })
})
