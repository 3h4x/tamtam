import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'pipeline-strip-late-phases-ui'

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

type LatePhase = 'idle' | 'mark-dod' | 'mark-dod-failed' | 'pr-wait' | 'pr-wait-failed' | 'soak' | 'done'

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
    detected_test_command: '',
    effective_test_command: '',
    test_cron_enabled: false,
    test_cron_schedule: '',
    auto_push_enabled: true,
    auto_commit_enabled: false,
    auto_pr_merge_enabled: true,
    pr_workflow_enabled: true,
    post_merge_watch_minutes: 5,
    auto_revert_enabled: false,
    release_after_run: false,
    tests_disabled: true,
    review_disabled: false,
    issue_auto_branch: false,
    last_push_error: null,
  }
}

function emptyIssuesSummary() {
  return {
    repo: '',
    prCount: 1,
    issueCount: 0,
    openPrBranches: ['feature/ui-late-phase'],
    error: null,
    cached: false,
    cachedAt: now(),
  }
}

function job(
  kind: string,
  status: 'done' | 'running',
  exitCode: number | null,
  startedOffset: number,
  extra: Partial<MockJob> = {},
): MockJob {
  return {
    id: `late-${kind}-1`,
    project: PROJECT,
    kind,
    status,
    exit_code: exitCode,
    started_at: now() - startedOffset,
    finished_at: status === 'done' ? now() - Math.max(startedOffset - 5, 1) : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: `${kind}-session`,
    release_id: 'late-release-1',
    context_meta: null,
    provider: 'claude',
    work_summary: `${kind} ${status}`,
    ...extra,
  }
}

function makeLatePhaseJobs(phase: LatePhase): MockJob[] {
  if (phase === 'idle' || phase === 'done') return []

  const release: MockJob = {
    id: 'late-release-1',
    project: PROJECT,
    kind: 'release',
    status: 'running',
    exit_code: null,
    started_at: now() - 120,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    context_meta: null,
    provider: 'claude',
    work_summary: 'Release pipeline is running.',
  }

  const completedEarlySteps = [
    job('review', 'done', 0, 100, { verdict: 'LGTM' }),
    job('commit', 'done', 0, 90),
    job('push', 'done', 0, 80),
  ]

  const markDodDone = job('mark-dod', 'done', 0, 70, {
    context_meta: JSON.stringify({ verified: 3, total: 3 }),
  })
  const prWaitDone = job('pr-wait', 'done', 0, 60)

  if (phase === 'mark-dod') {
    return [
      release,
      ...completedEarlySteps,
      job('mark-dod', 'running', null, 40, {
        context_meta: JSON.stringify({ verified: 1, total: 3 }),
      }),
    ]
  }

  if (phase === 'mark-dod-failed') {
    return [
      release,
      ...completedEarlySteps,
      job('mark-dod', 'done', 1, 40, {
        context_meta: JSON.stringify({ verified: 1, total: 3 }),
      }),
    ]
  }

  if (phase === 'pr-wait') {
    return [
      release,
      ...completedEarlySteps,
      markDodDone,
      job('pr-wait', 'running', null, 35),
    ]
  }

  if (phase === 'pr-wait-failed') {
    return [
      release,
      ...completedEarlySteps,
      markDodDone,
      job('pr-wait', 'done', 1, 35),
    ]
  }

  return [
    release,
    ...completedEarlySteps,
    markDodDone,
    prWaitDone,
    job('soak', 'running', null, 25),
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
    route.fulfill({
      json: {
        branch: 'feature/ui-late-phase',
        defaultBranch: 'master',
        commitsAhead: 0,
      },
    }),
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
    (route: Route) => route.fulfill({
      json: {
        total: jobs().length,
        byKind: {},
        byStatus: {
          running: jobs().filter((j) => j.status === 'running').length,
          done: 0,
          aborted: 0,
          failed: 0,
        },
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        cost: { total: 0, monthToDate: 0 },
      },
    }),
  )
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
}

test.describe('Pipeline strip late PR workflow phases', () => {
  test('terminal strip advances through DoD, merge, and soak, then hides without reload', async ({
    page,
  }) => {
    let phase: LatePhase = 'idle'

    await stubProjectShell(page, () => makeLatePhaseJobs(phase))
    await page.goto(`/project/${PROJECT}/terminal`)

    const stablePath = new URL(page.url()).pathname
    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0)

    phase = 'mark-dod'
    await expect(page.getByLabel(/pipeline summary: dod running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/dod: running\. DoD verification in progress/i)).toBeVisible({
      timeout: 12_000,
    })

    phase = 'pr-wait'
    await expect(page.getByLabel(/pipeline summary: merge running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/dod: done\. DoD: 3 \/ 3 verified/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/merge: running\. waiting for CI checks and auto-merge/i)).toBeVisible({
      timeout: 12_000,
    })

    phase = 'soak'
    await expect(page.getByLabel(/pipeline summary: soak running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/merge: done\. merge completed/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(
      page.getByLabel(/soak: running\. watching default-branch CI on the merge commit/i),
    ).toBeVisible({ timeout: 12_000 })

    phase = 'done'
    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, { timeout: 12_000 })
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath)
  })

  test('DoD failure stays visible in the strip with release controls', async ({ page }) => {
    let phase: LatePhase = 'mark-dod'

    await stubProjectShell(page, () => makeLatePhaseJobs(phase))
    await page.goto(`/project/${PROJECT}/terminal`)

    const stablePath = new URL(page.url()).pathname

    await expect(page.getByLabel(/pipeline summary: dod running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByTitle('DoD verification in progress — click to open terminal')).toBeVisible({
      timeout: 12_000,
    })

    phase = 'mark-dod-failed'

    await expect(page.getByLabel(/pipeline summary: dod needs attention/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByTitle('DoD: 1 / 3 verified — 2 unticked — click to view log')).toBeVisible({
      timeout: 12_000,
    })
    await expect(
      page.getByLabel(/dod: attention\. DoD: 1 \/ 3 verified — 2 unticked/i),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel(/dod: running\./i)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByTitle('View unified release trace')).toBeVisible({ timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible({ timeout: 12_000 })
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath)
  })

  test('merge failure replaces the running merge state without orphaning a spinner', async ({
    page,
  }) => {
    let phase: LatePhase = 'pr-wait'

    await stubProjectShell(page, () => makeLatePhaseJobs(phase))
    await page.goto(`/project/${PROJECT}/terminal`)

    const stablePath = new URL(page.url()).pathname

    await expect(page.getByLabel(/pipeline summary: merge running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(
      page.getByTitle('waiting for CI checks and auto-merge — click to open terminal'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel(/merge: running\./i)).toBeVisible({ timeout: 12_000 })

    phase = 'pr-wait-failed'

    await expect(page.getByLabel(/pipeline summary: merge failed/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByTitle('merge failed — click to view log')).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/merge: failed\. merge failed/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/merge: running\./i)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByTitle('View unified release trace')).toBeVisible({ timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible({ timeout: 12_000 })
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath)
  })
})
