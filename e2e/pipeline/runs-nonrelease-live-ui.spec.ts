import { test, expect } from '@playwright/test'
import type { Route } from '@playwright/test'

const RUN_PROJECT = 'runs-chat-live'
const AGENT_PROJECT = 'runs-agent-live'

const now = () => Math.floor(Date.now() / 1000)

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

type MockJob = {
  id: string
  project: string
  kind: string
  prompt: string | null
  status: 'running' | 'done'
  exit_code: number | null
  started_at: number
  finished_at: number | null
  seen?: boolean
  pid?: number
  log_path?: string
  session_id?: string | null
  user_prompt?: string | null
  work_summary?: string | null
}

function makeJob(overrides: Partial<MockJob> & Pick<MockJob, 'id' | 'project' | 'kind' | 'status' | 'exit_code' | 'started_at' | 'finished_at'>): MockJob {
  return {
    prompt: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    user_prompt: null,
    work_summary: null,
    ...overrides,
  }
}

async function stubRunsShellRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [makeTask(RUN_PROJECT), makeTask(AGENT_PROJECT)],
        priorities: [],
        issueCounts: {},
      },
    }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/jobs/counts', (route: Route) =>
    route.fulfill({
      json: {
        total: 2,
        byKind: { run: 1, 'agent:planner': 1 },
        byStatus: { running: 2, done: 0, aborted: 0, failed: 0 },
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        cost: { total: 0, monthToDate: 0 },
      },
    }),
  )
}

function runRow(page: import('@playwright/test').Page, project: string) {
  return page.getByRole('button').filter({ hasText: project }).first()
}

test.describe('Runs page non-release live polling', () => {
  test('global list picks up a newly-started chat run without reload', async ({ page }) => {
    let serveRunning = false

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      route.fulfill({
        json: {
          jobs: serveRunning
            ? [
                makeJob({
                  id: 'chat-run-live-start-1',
                  project: RUN_PROJECT,
                  kind: 'run',
                  prompt: 'Watch for a newly-started job',
                  user_prompt: 'Watch for a newly-started job',
                  session_id: 'sess-chat-run-live-start-1',
                  status: 'running',
                  exit_code: null,
                  started_at: now() - 8,
                  finished_at: null,
                  work_summary: 'Bootstrapping the live run',
                }),
              ]
            : [],
          total: serveRunning ? 1 : 0,
          pendingReleaseProjects: [],
        },
      })
    })
    await page.route('**/api/jobs/counts', (route: Route) =>
      route.fulfill({
        json: {
          total: serveRunning ? 1 : 0,
          byKind: serveRunning ? { run: 1 } : {},
          byStatus: {
            running: serveRunning ? 1 : 0,
            done: 0,
            aborted: 0,
            failed: 0,
          },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
    )

    await page.goto('/runs')

    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Runs appear here after terminal work')).toBeVisible()
    await expect(runRow(page, RUN_PROJECT)).toHaveCount(0)

    serveRunning = true

    const row = runRow(page, RUN_PROJECT)
    await expect(row).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText('running', { exact: true })).toBeVisible()
    await expect(row.getByText('Watch for a newly-started job')).toBeVisible()
    await expect(row.getByText('Bootstrapping the live run')).toBeVisible()
    await expect(page.getByText('No runs yet')).toHaveCount(0)
  })

  test('chat run row flips from running to done without reload', async ({ page }) => {
    let serveRunning = true

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      const running = serveRunning
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-live-1',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Summarize the diff',
              user_prompt: 'Summarize the diff',
              session_id: 'sess-chat-run-live-1',
              status: running ? 'running' : 'done',
              exit_code: running ? null : 0,
              started_at: now() - 60,
              finished_at: running ? null : now() - 5,
            }),
          ],
          total: 1,
          pendingReleaseProjects: [],
        },
      })
    })

    await page.goto('/runs')

    const row = runRow(page, RUN_PROJECT)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByText('chat')).toBeVisible()
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText('running', { exact: true })).toBeVisible()

    serveRunning = false

    await expect(row.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(row.getByText('done', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(row.getByText('Summarize the diff')).toBeVisible()
  })

  test('chat and agent rows keep independent state when only one job completes', async ({ page }) => {
    let pollCount = 0

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      pollCount += 1
      const chatDone = pollCount >= 2
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-live-2',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Check release notes',
              user_prompt: 'Check release notes',
              session_id: 'sess-chat-run-live-2',
              status: chatDone ? 'done' : 'running',
              exit_code: chatDone ? 0 : null,
              started_at: now() - 80,
              finished_at: chatDone ? now() - 10 : null,
            }),
            makeJob({
              id: 'agent-run-live-1',
              project: AGENT_PROJECT,
              kind: 'agent:planner',
              prompt: 'Planner agent',
              user_prompt: 'Planner agent',
              status: 'running',
              exit_code: null,
              started_at: now() - 50,
              finished_at: null,
              work_summary: 'Reviewing open items',
            }),
          ],
          total: 2,
          pendingReleaseProjects: [],
        },
      })
    })

    await page.goto('/runs')

    const chatRow = runRow(page, RUN_PROJECT)
    const agentRow = runRow(page, AGENT_PROJECT)

    await expect(chatRow).toBeVisible({ timeout: 8_000 })
    await expect(agentRow).toBeVisible({ timeout: 8_000 })
    await expect(chatRow.getByLabel('running')).toBeVisible()
    await expect(agentRow.getByLabel('running')).toBeVisible()
    await expect(agentRow.getByText('agent')).toBeVisible()

    await expect(chatRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(chatRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(agentRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(agentRow.getByText('running', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(agentRow.getByText('Reviewing open items')).toBeVisible()
  })

  test('chat run row flips from running to exit code failure without reload', async ({ page }) => {
    let serveRunning = true

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      const running = serveRunning
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-live-fail-1',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Run the release notes audit',
              user_prompt: 'Run the release notes audit',
              session_id: 'sess-chat-run-live-fail-1',
              status: running ? 'running' : 'done',
              exit_code: running ? null : 2,
              started_at: now() - 70,
              finished_at: running ? null : now() - 4,
              work_summary: running ? 'Inspecting recent changes' : 'Provider exited before completing the audit',
            }),
          ],
          total: 1,
          pendingReleaseProjects: [],
        },
      })
    })

    await page.goto('/runs')

    const row = runRow(page, RUN_PROJECT)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText('running', { exact: true })).toBeVisible()
    await expect(row.getByText('Inspecting recent changes')).toBeVisible()

    serveRunning = false

    await expect(row.getByLabel('needs attention')).toBeVisible({ timeout: 12_000 })
    await expect(row.getByText('exit 2', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(row.getByText('Provider exited before completing the audit')).toBeVisible({
      timeout: 12_000,
    })
  })

  test('active running filter turns into an empty state when its only job completes', async ({ page }) => {
    let serveRunning = true

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      const running = serveRunning
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-filter-complete-1',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Check the live filter state',
              user_prompt: 'Check the live filter state',
              session_id: 'sess-chat-run-filter-complete-1',
              status: running ? 'running' : 'done',
              exit_code: running ? null : 0,
              started_at: now() - 60,
              finished_at: running ? null : now() - 5,
              work_summary: running ? 'Checking active work' : 'Live filter check complete',
            }),
          ],
          total: 1,
          pendingReleaseProjects: [],
        },
      })
    })

    await page.goto('/runs')

    const row = runRow(page, RUN_PROJECT)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()

    await page.getByRole('button', { name: /^running/ }).click()
    await expect(row).toBeVisible()
    await expect(page.getByText('Nothing is running right now')).toHaveCount(0)

    serveRunning = false

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByText('There is no active run in all projects right now.')).toBeVisible()
    await expect(row).toHaveCount(0)

    await page.getByRole('button', { name: /^done/ }).click()
    const doneRow = runRow(page, RUN_PROJECT)
    await expect(doneRow).toBeVisible()
    await expect(doneRow.getByLabel('done')).toBeVisible()
    await expect(doneRow.getByText('Live filter check complete')).toBeVisible()
  })

  test('agent row flips from running to cancelled without disturbing a concurrent chat run', async ({ page }) => {
    let pollCount = 0

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      pollCount += 1
      const agentCancelled = pollCount >= 2
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-live-steady-1',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Keep watching the release queue',
              user_prompt: 'Keep watching the release queue',
              session_id: 'sess-chat-run-live-steady-1',
              status: 'running',
              exit_code: null,
              started_at: now() - 90,
              finished_at: null,
              work_summary: 'Waiting for the next run to finish',
            }),
            makeJob({
              id: 'agent-run-live-cancel-1',
              project: AGENT_PROJECT,
              kind: 'agent:planner',
              prompt: 'Planner agent',
              user_prompt: 'Planner agent',
              status: agentCancelled ? 'done' : 'running',
              exit_code: agentCancelled ? -3 : null,
              started_at: now() - 45,
              finished_at: agentCancelled ? now() - 6 : null,
              work_summary: agentCancelled ? 'Cancelled by operator during planning' : 'Drafting next actions',
            }),
          ],
          total: 2,
          pendingReleaseProjects: [],
        },
      })
    })

    await page.goto('/runs')

    const chatRow = runRow(page, RUN_PROJECT)
    const agentRow = runRow(page, AGENT_PROJECT)

    await expect(chatRow).toBeVisible({ timeout: 8_000 })
    await expect(agentRow).toBeVisible({ timeout: 8_000 })
    await expect(chatRow.getByLabel('running')).toBeVisible()
    await expect(agentRow.getByLabel('running')).toBeVisible()
    await expect(agentRow.getByText('Drafting next actions')).toBeVisible()

    await expect(agentRow.getByLabel('needs attention')).toBeVisible({ timeout: 12_000 })
    await expect(agentRow.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(agentRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(agentRow.getByText('Cancelled by operator during planning')).toBeVisible({
      timeout: 12_000,
    })

    await expect(chatRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(chatRow.getByText('running', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(chatRow.getByText('Waiting for the next run to finish')).toBeVisible()
  })

  test('header running total clears after the counts poll follows a completed row', async ({ page }) => {
    let serveRunning = true

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      const running = serveRunning
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-header-count-1',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Check aggregate counts',
              user_prompt: 'Check aggregate counts',
              session_id: 'sess-chat-run-header-count-1',
              status: running ? 'running' : 'done',
              exit_code: running ? null : 0,
              started_at: now() - 70,
              finished_at: running ? null : now() - 6,
              work_summary: running ? 'Counting active work' : 'Aggregate count check complete',
            }),
          ],
          total: 1,
          pendingReleaseProjects: [],
        },
      })
    })
    await page.route('**/api/jobs/counts', (route: Route) =>
      route.fulfill({
        json: {
          total: 1,
          byKind: { run: 1 },
          byStatus: {
            running: serveRunning ? 1 : 0,
            done: serveRunning ? 0 : 1,
            aborted: 0,
            failed: 0,
          },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
    )

    await page.goto('/runs')

    const row = runRow(page, RUN_PROJECT)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(page.getByText(/1 total run .* 1 running/)).toBeVisible()

    serveRunning = false

    await expect(row.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(row.getByText('Aggregate count check complete')).toBeVisible({ timeout: 12_000 })

    await expect(page.getByText(/1 total run .* 1 running/)).toHaveCount(0, {
      timeout: 20_000,
    })
    await expect(page.getByText(/1 total run .* 1 grouped entry/)).toBeVisible()
  })

  test('header running total appears when a new chat run starts without reload', async ({ page }) => {
    let serveRunning = false

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      route.fulfill({
        json: {
          jobs: serveRunning
            ? [
                makeJob({
                  id: 'chat-run-header-start-1',
                  project: RUN_PROJECT,
                  kind: 'run',
                  prompt: 'Start from an empty run list',
                  user_prompt: 'Start from an empty run list',
                  session_id: 'sess-chat-run-header-start-1',
                  status: 'running',
                  exit_code: null,
                  started_at: now() - 5,
                  finished_at: null,
                  work_summary: 'New run just started',
                }),
              ]
            : [],
          total: serveRunning ? 1 : 0,
          pendingReleaseProjects: [],
        },
      })
    })
    await page.route('**/api/jobs/counts', (route: Route) =>
      route.fulfill({
        json: {
          total: serveRunning ? 1 : 0,
          byKind: serveRunning ? { run: 1 } : {},
          byStatus: {
            running: serveRunning ? 1 : 0,
            done: 0,
            aborted: 0,
            failed: 0,
          },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
    )

    await page.goto('/runs')

    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/0 total runs/)).toBeVisible()
    await expect(runRow(page, RUN_PROJECT)).toHaveCount(0)

    serveRunning = true

    const row = runRow(page, RUN_PROJECT)
    await expect(row).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText('New run just started')).toBeVisible()

    await expect(page.getByText(/1 total run .* 1 running/)).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByRole('button', { name: /^running 1$/ })).toBeVisible()
    await expect(page.getByText('No runs yet')).toHaveCount(0)
  })
})
