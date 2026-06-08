import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Pure page.route() UI test: asserts the pipeline summary progress badge
// (doneCount/totalCount) advances as steps complete, without a page reload.
// Not registered in global-setup — every request the project shell makes is
// stubbed below, so no isolated DB project is required.

const PROJECT = 'pipeline-strip-progress-counter'

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

type Phase = 'idle' | 'test' | 'review' | 'fix' | 'commit' | 'push'

const RELEASE_ID = 'strip-progress-release-1'

function releaseJob(): MockJob {
  return {
    id: RELEASE_ID,
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
}

function step(
  kind: string,
  id: string,
  status: 'done' | 'running',
  exitCode: number | null,
  verdict?: string,
): MockJob {
  return {
    id,
    project: PROJECT,
    kind,
    status,
    exit_code: exitCode,
    started_at: now() - 50,
    finished_at: status === 'done' ? now() - 45 : null,
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

// Returns the release chain for a phase. The visible-steps progress badge is
// doneCount/totalCount where totalCount = the number of distinct pipeline kinds
// surfaced so far. Expected badge values are documented per phase:
//   test    → [test(running)]                                      → 0/1
//   review  → [test(done), review(running)]                        → 1/2
//   fix     → [test(done), review(attention), fix(running)]        → 1/3
//   commit  → [test(done), review(LGTM), fix(done), commit(run)]   → 3/4
//   push    → [test, review(LGTM), fix, commit(done), push(run)]   → 4/5
function makeChain(phase: Phase): MockJob[] {
  if (phase === 'idle') return []
  const base = [releaseJob()]
  if (phase === 'test') return [...base, step('test', 'strip-progress-test', 'running', null)]
  if (phase === 'review') {
    return [
      ...base,
      step('test', 'strip-progress-test', 'done', 0),
      step('review', 'strip-progress-review', 'running', null),
    ]
  }
  if (phase === 'fix') {
    return [
      ...base,
      step('test', 'strip-progress-test', 'done', 0),
      step('review', 'strip-progress-review', 'done', 0, 'NEEDS ATTENTION'),
      step('fix', 'strip-progress-fix', 'running', null),
    ]
  }
  if (phase === 'commit') {
    return [
      ...base,
      step('test', 'strip-progress-test', 'done', 0),
      step('review', 'strip-progress-review', 'done', 0, 'LGTM'),
      step('fix', 'strip-progress-fix', 'done', 0),
      step('commit', 'strip-progress-commit', 'running', null),
    ]
  }
  return [
    ...base,
    step('test', 'strip-progress-test', 'done', 0),
    step('review', 'strip-progress-review', 'done', 0, 'LGTM'),
    step('fix', 'strip-progress-fix', 'done', 0),
    step('commit', 'strip-progress-commit', 'done', 0),
    step('push', 'strip-progress-push', 'running', null),
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

test.describe('Pipeline strip progress counter', () => {
  test('progress badge advances 0/1 → 1/2 → 1/3 → 3/4 → 4/5 as steps complete without reload', async ({
    page,
  }) => {
    let phase: Phase = 'idle'

    await stubProjectShell(page, () => makeChain(phase))
    await page.goto(`/project/${PROJECT}/terminal`)

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0)
    const stablePath = new URL(page.url()).pathname

    const summary = page.getByLabel(/pipeline summary:/i)

    phase = 'test'
    await expect(summary).toContainText('0/1', { timeout: 12_000 })

    phase = 'review'
    await expect(summary).toContainText('1/2', { timeout: 12_000 })

    phase = 'fix'
    // review NEEDS ATTENTION does not count toward done — only test is done.
    await expect(summary).toContainText('1/3', { timeout: 12_000 })

    phase = 'commit'
    await expect(summary).toContainText('3/4', { timeout: 12_000 })

    phase = 'push'
    await expect(summary).toContainText('4/5', { timeout: 12_000 })

    // No client-side navigation happened across the whole lifecycle.
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath)
  })
})
