import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'pipeline-strip-live-polling'

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
    last_push_error: 'Push failed: remote rejected: protected branch',
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

function makeReleaseChain(phase: 'idle' | 'test' | 'review' | 'fix' | 'commit' | 'push' | 'push-failed' | 'done'): MockJob[] {
  if (phase === 'idle' || phase === 'done') return []

  const releaseId = 'strip-live-release-1'
  const releaseJob: MockJob = {
    id: releaseId,
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

  const steps: MockJob[] = [releaseJob]
  const pushStep = (status: 'done' | 'running', exitCode: number | null) => ({
    id: 'strip-live-push-1',
    project: PROJECT,
    kind: 'push',
    status,
    exit_code: exitCode,
    started_at: now() - 15,
    finished_at: status === 'done' ? now() - 10 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Push is running.' : 'Push completed.',
  })

  const commitStep = (status: 'done' | 'running', exitCode: number | null) => ({
    id: 'strip-live-commit-1',
    project: PROJECT,
    kind: 'commit',
    status,
    exit_code: exitCode,
    started_at: now() - 25,
    finished_at: status === 'done' ? now() - 20 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Commit is running.' : 'Commit completed.',
  })

  const fixStep = (status: 'done' | 'running', exitCode: number | null) => ({
    id: 'strip-live-fix-1',
    project: PROJECT,
    kind: 'fix',
    status,
    exit_code: exitCode,
    started_at: now() - 35,
    finished_at: status === 'done' ? now() - 30 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: 'strip-live-fix-session',
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Fix is running.' : 'Fix completed.',
  })

  const reviewStep = (
    status: 'done' | 'running',
    exitCode: number | null,
    verdict?: string,
  ) => ({
    id: 'strip-live-review-1',
    project: PROJECT,
    kind: 'review',
    status,
    exit_code: exitCode,
    started_at: now() - 45,
    finished_at: status === 'done' ? now() - 40 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: 'strip-live-review-session',
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Review is running.' : 'Review completed.',
    ...(verdict ? { verdict } : {}),
  })

  const testStep = (status: 'done' | 'running', exitCode: number | null) => ({
    id: 'strip-live-test-1',
    project: PROJECT,
    kind: 'test',
    status,
    exit_code: exitCode,
    started_at: now() - 55,
    finished_at: status === 'done' ? now() - 50 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: 'strip-live-test-session',
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Tests are running.' : 'Tests completed.',
  })

  if (phase === 'test') return [...steps, testStep('running', null)]
  if (phase === 'review') return [...steps, testStep('done', 0), reviewStep('running', null)]
  if (phase === 'fix') {
    return [
      ...steps,
      testStep('done', 0),
      reviewStep('done', 0, 'NEEDS ATTENTION'),
      fixStep('running', null),
    ]
  }
  if (phase === 'commit') {
    return [
      ...steps,
      testStep('done', 0),
      reviewStep('done', 0, 'LGTM'),
      fixStep('done', 0),
      commitStep('running', null),
    ]
  }
  if (phase === 'push-failed') {
    return [
      ...steps,
      testStep('done', 0),
      reviewStep('done', 0, 'LGTM'),
      fixStep('done', 0),
      commitStep('done', 0),
      pushStep('done', 1),
    ]
  }
  return [
    ...steps,
    testStep('done', 0),
    reviewStep('done', 0, 'LGTM'),
    fixStep('done', 0),
    commitStep('done', 0),
    pushStep('running', null),
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
    (route: Route) => {
      const currentJobs = jobs()
      const running = currentJobs.filter((job) => job.status === 'running').length
      const done = currentJobs.filter((job) => job.status === 'done').length
      const failed = currentJobs.filter(
        (job) => typeof job.exit_code === 'number' && job.exit_code !== 0,
      ).length
      route.fulfill({
        json: {
          total: currentJobs.length,
          byKind: currentJobs.reduce<Record<string, number>>((acc, job) => {
            acc[job.kind] = (acc[job.kind] ?? 0) + 1
            return acc
          }, {}),
          byStatus: { running, done, aborted: 0, failed },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      })
    },
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

test.describe('Pipeline strip live polling', () => {
  test('page already open advances through test, review, fix, commit, and push, then hides the strip without reload', async ({
    page,
  }) => {
    let phase: 'idle' | 'test' | 'review' | 'fix' | 'commit' | 'push' | 'done' = 'idle'

    await stubProjectShell(page, () => makeReleaseChain(phase))
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0)
    const stablePath = new URL(page.url()).pathname

    phase = 'test'
    await expect(page.getByLabel(/pipeline summary: test running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/test: running\./i)).toBeVisible({ timeout: 12_000 })

    phase = 'review'
    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/test: done\./i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel(/review: running\./i)).toBeVisible({ timeout: 12_000 })

    phase = 'fix'
    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/review: attention\./i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel(/fix: running\./i)).toBeVisible({ timeout: 12_000 })

    phase = 'commit'
    await expect(page.getByLabel(/pipeline summary: commit running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/review: done\./i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel(/fix: done\./i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel(/commit: running\./i)).toBeVisible({ timeout: 12_000 })

    phase = 'push'
    await expect(page.getByLabel(/pipeline summary: push running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/commit: done\./i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel(/push: running\./i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible({ timeout: 12_000 })

    phase = 'done'
    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, { timeout: 12_000 })
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath)
  })

  test('push step failure updates the strip from running to failed without hiding recovery controls', async ({
    page,
  }) => {
    let phase: 'push' | 'push-failed' = 'push'

    await stubProjectShell(page, () => makeReleaseChain(phase))
    await page.goto(`/project/${PROJECT}/terminal`)

    const stablePath = new URL(page.url()).pathname

    await expect(page.getByLabel(/pipeline summary: push running/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/push: running\./i)).toBeVisible({ timeout: 12_000 })
    await expect(page.getByTitle('push in progress — click to open terminal')).toBeVisible({
      timeout: 12_000,
    })

    phase = 'push-failed'

    await expect(page.getByLabel(/pipeline summary: push failed/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/push: failed\. Push failed: remote rejected: protected branch/i)).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByLabel(/pipeline summary: push failed/i)).toHaveAttribute(
      'title',
      'Push failed: remote rejected: protected branch',
    )
    await expect(page.getByRole('button', {
      name: /push: failed\. Push failed: remote rejected: protected branch/i,
    })).toHaveAttribute('title', 'Push failed: remote rejected: protected branch')
    await expect(page.getByRole('button', { name: 'retry push' })).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByTitle('View unified release trace')).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel(/push: running\./i)).toHaveCount(0, { timeout: 12_000 })
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath)
  })
})
