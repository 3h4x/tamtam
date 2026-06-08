import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Pure page.route() UI spec. It covers an in-place route transition between
// project history pages while the destination project's jobs request is still
// pending. The old project's rows must clear immediately; otherwise the UI
// briefly reports the wrong job lifecycle for the new project.

const PROJECT_A = 'history-switch-source'
const PROJECT_B = 'history-switch-target'
const SOURCE_SUMMARY = 'Source project run must not survive the project switch'
const TARGET_SUMMARY = 'Target project run appears after its jobs load'

const now = () => Math.floor(Date.now() / 1000)

type MockJob = {
  id: string
  project: string
  kind: string
  prompt: string | null
  user_prompt: string | null
  work_summary: string | null
  session_id: string | null
  status: 'running' | 'done'
  exit_code: number | null
  started_at: number
  finished_at: number | null
  seen?: boolean
  pid?: number
  log_path?: string
}

function makeTask(project: string) {
  return {
    id: `${project}-1`,
    project,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${project}`,
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

function makeProjectConfig(project: string) {
  return {
    project,
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

function makeRun(project: string, id: string, summary: string): MockJob {
  return {
    id,
    project,
    kind: 'run',
    prompt: summary,
    user_prompt: summary,
    work_summary: summary,
    session_id: `sess-${id}`,
    status: 'done',
    exit_code: 0,
    started_at: now() - 60,
    finished_at: now() - 30,
    seen: true,
    pid: 0,
    log_path: '',
  }
}

function countsFor(jobs: MockJob[]) {
  const byKind = jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.kind] = (acc[job.kind] ?? 0) + 1
    return acc
  }, {})
  return {
    total: jobs.length,
    byKind,
    byStatus: {
      running: jobs.filter((job) => job.status === 'running').length,
      done: jobs.filter((job) => job.status === 'done').length,
      aborted: 0,
      failed: jobs.filter((job) => job.exit_code !== null && job.exit_code !== 0).length,
    },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
    cost: { total: 0, monthToDate: 0 },
  }
}

function runRow(page: Page, text: string) {
  return page.getByRole('button').filter({ hasText: text }).first()
}

async function clickClientRoute(page: Page, href: string): Promise<void> {
  await page.evaluate((targetHref) => {
    const anchor = document.createElement('a')
    anchor.href = targetHref
    anchor.textContent = 'switch project'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }, href)
}

async function stubTwoProjectHistoryShell(
  page: Page,
  opts: {
    sourceJobs: MockJob[]
    targetJobs: MockJob[]
    releaseTargetJobs: () => void
    targetJobsReady: Promise<void>
  },
): Promise<void> {
  const projects = [PROJECT_A, PROJECT_B]
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: projects.map(makeTask), priorities: [], issueCounts: {} },
    }),
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

  for (const project of projects) {
    await page.route(`**/api/projects/by-project/${project}/config`, (route: Route) =>
      route.fulfill({ json: makeProjectConfig(project) }),
    )
    await page.route(`**/api/projects/by-project/${project}/action`, (route: Route) =>
      route.fulfill({ json: { actions: [] } }),
    )
    await page.route(`**/api/agents?project=${project}`, (route: Route) =>
      route.fulfill({ json: { agents: [] } }),
    )
    await page.route(`**/api/projects/by-project/${project}/branch`, (route: Route) =>
      route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
    )
    await page.route(`**/api/projects/by-project/${project}/behind`, (route: Route) =>
      route.fulfill({ json: { behind: 0, ahead: 0 } }),
    )
    await page.route(`**/api/projects/by-project/${project}/issues`, (route: Route) =>
      route.fulfill({ json: { prs: [], issues: [] } }),
    )
    await page.route(
      (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === project,
      (route: Route) => route.fulfill({ json: { items: [] } }),
    )
  }

  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT_A,
    (route: Route) =>
      route.fulfill({
        json: { jobs: opts.sourceJobs, total: opts.sourceJobs.length, pendingReleaseProjects: [] },
      }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT_B,
    async (route: Route) => {
      opts.releaseTargetJobs()
      await opts.targetJobsReady
      await route.fulfill({
        json: { jobs: opts.targetJobs, total: opts.targetJobs.length, pendingReleaseProjects: [] },
      })
    },
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT_A,
    (route: Route) => route.fulfill({ json: countsFor(opts.sourceJobs) }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT_B,
    (route: Route) => route.fulfill({ json: countsFor(opts.targetJobs) }),
  )
}

test.describe('History project switch lifecycle state', () => {
  test('clears old project rows while the destination jobs request is pending', async ({ page }) => {
    const sourceJobs = [makeRun(PROJECT_A, 'source-run', SOURCE_SUMMARY)]
    const targetJobs = [makeRun(PROJECT_B, 'target-run', TARGET_SUMMARY)]
    let targetJobsRequested = false
    let resolveTargetJobs!: () => void
    const targetJobsReady = new Promise<void>((resolve) => {
      resolveTargetJobs = resolve
    })

    await stubTwoProjectHistoryShell(page, {
      sourceJobs,
      targetJobs,
      targetJobsReady,
      releaseTargetJobs: () => {
        targetJobsRequested = true
      },
    })

    await page.goto(`/project/${PROJECT_A}/history`)
    await expect(runRow(page, SOURCE_SUMMARY)).toBeVisible({ timeout: 8_000 })

    await clickClientRoute(page, `/project/${PROJECT_B}/history`)
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT_B}/history$`), { timeout: 8_000 })
    await expect
      .poll(() => targetJobsRequested, { timeout: 8_000 })
      .toBe(true)

    await expect(runRow(page, SOURCE_SUMMARY)).toHaveCount(0, { timeout: 8_000 })

    resolveTargetJobs()
    await expect(runRow(page, TARGET_SUMMARY)).toBeVisible({ timeout: 8_000 })
    await expect(runRow(page, SOURCE_SUMMARY)).toHaveCount(0)
  })
})
