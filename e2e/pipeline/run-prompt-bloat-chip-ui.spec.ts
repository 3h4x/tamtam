import { test, expect } from '@playwright/test'
import type { BrowserContext, Route } from '@playwright/test'

// Exercises the RunRow prompt-bloat chip (components/project-runs/RunRow.tsx
// showPromptChip / promptIsAlert). The chip is a recurring-cost signal: a fat
// prompt prefix is billed on every cache-read. Thresholds are WARN >= 20 KB
// (status-warning tone) and ALERT >= 50 KB (status-error tone); below 20 KB no
// chip renders.

const PROJECT = 'run-prompt-bloat-chip'

const now = () => Math.floor(Date.now() / 1000)

// Bytes -> rendered "prompt NKB" label: Math.round(bytes / 1024).
const SMALL_BYTES = 5_000 // below WARN -> no chip
const WARN_BYTES = 25_000 // round(24.41) = 24KB, warning tone
const ALERT_BYTES = 60_000 // round(58.59) = 59KB, error tone
const WARN_LABEL = `prompt ${Math.round(WARN_BYTES / 1024)}KB`
const ALERT_LABEL = `prompt ${Math.round(ALERT_BYTES / 1024)}KB`

const SMALL_PROMPT = 'Small prompt run — well under the bloat threshold.'
const WARN_PROMPT = 'Warn prompt run — above the warn threshold.'
const ALERT_PROMPT = 'Alert prompt run — above the alert threshold.'

function runJob(id: string, prompt: string, promptBytes: number) {
  return {
    id,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: 0,
    started_at: now() - 120,
    finished_at: now() - 90,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: id,
    user_prompt: prompt,
    prompt,
    context_meta: null,
    provider: 'claude',
    work_summary: null,
    prompt_bytes: promptBytes,
  }
}

function jobs() {
  return [
    runJob('prompt-bloat-small', SMALL_PROMPT, SMALL_BYTES),
    runJob('prompt-bloat-warn', WARN_PROMPT, WARN_BYTES),
    runJob('prompt-bloat-alert', ALERT_PROMPT, ALERT_BYTES),
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

async function stubRoutes(context: BrowserContext): Promise<void> {
  await context.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  )
  await context.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
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
          total: 3,
          byKind: { run: 3 },
          byStatus: { running: 0, done: 3, aborted: 0, failed: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
  )
}

test.describe('RunRow prompt-bloat chip', () => {
  test('renders warning vs alert chips by byte threshold and omits it under the warn floor', async ({
    page,
  }) => {
    await stubRoutes(page.context())
    await page.goto(`/project/${PROJECT}/history`)

    const smallRow = page.getByRole('button').filter({ hasText: SMALL_PROMPT }).first()
    const warnRow = page.getByRole('button').filter({ hasText: WARN_PROMPT }).first()
    const alertRow = page.getByRole('button').filter({ hasText: ALERT_PROMPT }).first()

    await expect(smallRow).toBeVisible({ timeout: 8_000 })
    await expect(warnRow).toBeVisible({ timeout: 8_000 })
    await expect(alertRow).toBeVisible({ timeout: 8_000 })

    // Below 20 KB: no chip at all.
    await expect(smallRow.getByText(/^prompt \d/)).toHaveCount(0)

    // 20–50 KB: warning-toned chip with the rounded-KB label.
    const warnChip = warnRow.getByText(WARN_LABEL, { exact: true })
    await expect(warnChip).toBeVisible({ timeout: 8_000 })
    await expect(warnChip).toHaveClass(/text-status-warning/)
    await expect(warnChip).not.toHaveClass(/text-status-error/)
    await expect(warnChip).toHaveAttribute('title', /Every cache-read of this prefix is billed/)

    // >= 50 KB: same chip escalates to the error tone.
    const alertChip = alertRow.getByText(ALERT_LABEL, { exact: true })
    await expect(alertChip).toBeVisible({ timeout: 8_000 })
    await expect(alertChip).toHaveClass(/text-status-error/)
    await expect(alertChip).not.toHaveClass(/text-status-warning/)
  })
})
