import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Pure page.route() UI test: when a release runs the review→fix loop more than
// once, the strip collapses each kind to its latest job (latestPipelineJobsByKind).
// Without an iteration indicator the operator can't tell the loop cycled. This
// spec asserts the fix/review pills surface the per-kind iteration count when a
// kind ran more than once, and that single-pass runs show no such badge.

const PROJECT = 'pipeline-strip-fix-iteration'

const now = () => Math.floor(Date.now() / 1000)

type MockJob = {
  id: string
  project: string
  kind: string
  status: 'done' | 'running'
  exit_code: number | null
  started_at: number
  finished_at: number | null
  pid: number
  log_path: string
  seen: boolean
  session_id: string | null
  parent_job_id?: string | null
  release_id?: string | null
  context_meta: string | null
  provider: string
  work_summary: string
  verdict?: string
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
    changes: 5,
    unpushed: 0,
    reviewed: false,
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
    detected_test_command: '',
    effective_test_command: '',
    test_cron_enabled: false,
    test_cron_schedule: '',
    auto_push_enabled: false,
    auto_commit_enabled: false,
    auto_pr_merge_enabled: false,
    pr_workflow_enabled: false,
    release_after_run: false,
    tests_disabled: false,
    review_disabled: false,
    issue_auto_branch: false,
  }
}

function emptyIssuesSummary() {
  return {
    repo: '',
    prCount: 0,
    issueCount: 0,
    openPrBranches: [],
    error: null,
    cached: false,
    cachedAt: now(),
  }
}

const RELEASE_ID = 'strip-fix-iteration-release-1'

function releaseJob(): MockJob {
  return {
    id: RELEASE_ID,
    project: PROJECT,
    kind: 'release',
    status: 'running',
    exit_code: null,
    started_at: now() - 300,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    context_meta: null,
    provider: 'claude',
    work_summary: 'Release pipeline is running.',
  }
}

function step(
  kind: string,
  id: string,
  status: 'done' | 'running',
  exitCode: number | null,
  startedAgo: number,
  verdict?: string,
): MockJob {
  return {
    id,
    project: PROJECT,
    kind,
    status,
    exit_code: exitCode,
    started_at: now() - startedAgo,
    finished_at: status === 'done' ? now() - (startedAgo - 5) : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: `${id}-session`,
    release_id: RELEASE_ID,
    context_meta: null,
    provider: 'claude',
    work_summary: `${kind} ${status}.`,
    ...(verdict ? { verdict } : {}),
  }
}

// A release that has cycled the review→fix loop twice and is now mid second fix:
//   test(done) → review#1(NEEDS ATTENTION) → fix#1(done)
//             → review#2(NEEDS ATTENTION) → fix#2(running)
// latestPipelineJobsByKind keeps the latest review and latest fix only, so the
// strip shows one "review" pill and one "fix" pill — each must report 2 runs.
function twoFixIterationChain(): MockJob[] {
  return [
    releaseJob(),
    step('test', 'strip-fix-test', 'done', 0, 250),
    step('review', 'strip-fix-review-1', 'done', 0, 220, 'NEEDS ATTENTION'),
    step('fix', 'strip-fix-fix-1', 'done', 0, 190),
    step('review', 'strip-fix-review-2', 'done', 0, 120, 'NEEDS ATTENTION'),
    step('fix', 'strip-fix-fix-2', 'running', null, 60),
  ]
}

// Single-pass control: one review, one fix, no repeats.
function singlePassChain(): MockJob[] {
  return [
    releaseJob(),
    step('test', 'strip-fix-test', 'done', 0, 250),
    step('review', 'strip-fix-review-1', 'done', 0, 220, 'NEEDS ATTENTION'),
    step('fix', 'strip-fix-fix-1', 'running', null, 60),
  ]
}

async function stubProjectShell(page: Page, jobs: () => MockJob[]): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  )
  await page.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  )
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') === '1',
    (route: Route) => route.fulfill({ json: emptyIssuesSummary() }),
  )
  await page.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') !== '1',
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: jobs(), pendingReleaseProjects: [] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          total: 0,
          byKind: {},
          byStatus: { running: 0, done: 0, aborted: 0, failed: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
}

test.describe('Pipeline strip fix-loop iteration count', () => {
  test('fix and review pills report the iteration count when the loop cycled more than once', async ({
    page,
  }) => {
    await stubProjectShell(page, twoFixIterationChain)
    await page.goto(`/project/${PROJECT}/terminal`)

    // The fix pill is the running second iteration and must announce "2 runs".
    const fixPill = page.getByRole('button', { name: /fix: running, 2 runs/i })
    await expect(fixPill).toBeVisible({ timeout: 12_000 })
    await expect(fixPill).toContainText('·2')

    // The review pill collapsed two NEEDS ATTENTION runs into one — also "2 runs".
    const reviewPill = page.getByRole('button', { name: /review:.*2 runs/i })
    await expect(reviewPill).toBeVisible({ timeout: 12_000 })
    await expect(reviewPill).toContainText('·2')

    // The test pill ran once, so it carries no iteration badge.
    const testPill = page.getByRole('button', { name: /test: done/i })
    await expect(testPill).toBeVisible()
    await expect(testPill).not.toContainText('·')
  })

  test('single-pass run shows no iteration badge on any pill', async ({ page }) => {
    await stubProjectShell(page, singlePassChain)
    await page.goto(`/project/${PROJECT}/terminal`)

    const fixPill = page.getByRole('button', { name: /fix: running/i })
    await expect(fixPill).toBeVisible({ timeout: 12_000 })
    await expect(fixPill).not.toContainText('·')
    await expect(page.getByRole('button', { name: /fix: running, \d+ runs/i })).toHaveCount(0)

    const reviewPill = page.getByRole('button', { name: /review:/i })
    await expect(reviewPill).not.toContainText('·')
  })
})
