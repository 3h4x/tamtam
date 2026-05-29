import { test, expect } from '@playwright/test'
import type { Route } from '@playwright/test'

const RUN_PROJECT = 'runs-chat-live'
const AGENT_PROJECT = 'runs-agent-live'
const OTHER_PROJECT = 'runs-scope-reset-live'

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
        tasks: [makeTask(RUN_PROJECT), makeTask(AGENT_PROJECT), makeTask(OTHER_PROJECT)],
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

function filterChip(page: import('@playwright/test').Page, label: string) {
  return page.getByRole('button', { name: new RegExp(`^${label} \\d+$`, 'i') })
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

  test('active running filter repopulates when a new chat run starts after the filter has gone empty', async ({ page }) => {
    let serveRunning = true

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      route.fulfill({
        json: {
          jobs: serveRunning
            ? [
                makeJob({
                  id: 'chat-run-running-filter-start-1',
                  project: RUN_PROJECT,
                  kind: 'run',
                  prompt: 'Watch the running filter wake up',
                  user_prompt: 'Watch the running filter wake up',
                  session_id: 'sess-chat-run-running-filter-start-1',
                  status: 'running',
                  exit_code: null,
                  started_at: now() - 6,
                  finished_at: null,
                  work_summary: 'Fresh live work appeared while the running filter was active',
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

    const row = runRow(page, RUN_PROJECT)
    await expect(row).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 12_000 })

    await filterChip(page, 'running').click()
    await expect(row.getByText('Watch the running filter wake up')).toBeVisible({ timeout: 12_000 })

    serveRunning = false

    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Runs appear here after terminal work')).toBeVisible()
    await expect(runRow(page, RUN_PROJECT)).toHaveCount(0)

    serveRunning = true

    await expect(row).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(row.getByText('running', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(row.getByText('Watch the running filter wake up')).toBeVisible({ timeout: 12_000 })
    await expect(
      row.getByText('Fresh live work appeared while the running filter was active'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('No runs yet')).toHaveCount(0)
    await expect(filterChip(page, 'running')).toHaveText(/running 1/i, {
      timeout: 12_000,
    })
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
    await expect(row).toContainText('chat')
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText('running', { exact: true })).toBeVisible()

    serveRunning = false

    await expect(row.getByLabel('done')).toBeVisible({ timeout: 12_000 })
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
    await expect(agentRow).toContainText('agent')

    await expect(chatRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(chatRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(agentRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(agentRow.getByText('running', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(agentRow.getByText('Reviewing open items')).toBeVisible()
  })

  test('active running filter drops the completed row while keeping the other live row visible', async ({ page }) => {
    let pollCount = 0

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      pollCount += 1
      const chatDone = pollCount >= 2
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-running-filter-live-1',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Watch the running filter update',
              user_prompt: 'Watch the running filter update',
              session_id: 'sess-chat-run-running-filter-live-1',
              status: chatDone ? 'done' : 'running',
              exit_code: chatDone ? 0 : null,
              started_at: now() - 95,
              finished_at: chatDone ? now() - 6 : null,
              work_summary: chatDone ? 'Completed after the filter was already active' : 'Still running in the filtered list',
            }),
            makeJob({
              id: 'agent-run-running-filter-live-1',
              project: AGENT_PROJECT,
              kind: 'agent:planner',
              prompt: 'Planner agent',
              user_prompt: 'Planner agent',
              status: 'running',
              exit_code: null,
              started_at: now() - 55,
              finished_at: null,
              work_summary: 'Continuing to plan follow-up work',
            }),
          ],
          total: 2,
          pendingReleaseProjects: [],
        },
      })
    })
    await page.route('**/api/jobs/counts', (route: Route) =>
      route.fulfill({
        json: {
          total: 2,
          byKind: { run: 1, 'agent:planner': 1 },
          byStatus: {
            running: pollCount >= 2 ? 1 : 2,
            done: pollCount >= 2 ? 1 : 0,
            aborted: 0,
            failed: 0,
          },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      }),
    )

    await page.goto('/runs')

    const chatRow = runRow(page, RUN_PROJECT)
    const agentRow = runRow(page, AGENT_PROJECT)

    await expect(chatRow).toBeVisible({ timeout: 8_000 })
    await expect(agentRow).toBeVisible({ timeout: 8_000 })

    await filterChip(page, 'running').click()

    await expect(chatRow.getByLabel('running')).toBeVisible()
    await expect(agentRow.getByLabel('running')).toBeVisible()
    await expect(page.getByText('Nothing is running right now')).toHaveCount(0)

    await expect(chatRow).toHaveCount(0, { timeout: 12_000 })
    await expect(agentRow).toBeVisible({ timeout: 12_000 })
    await expect(agentRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(agentRow.getByText('Continuing to plan follow-up work')).toBeVisible()
    await expect(filterChip(page, 'running')).toHaveText(/running 1/i, { timeout: 12_000 })
    await expect(page.getByText('Nothing is running right now')).toHaveCount(0)
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

  test('active failed filter includes a running chat run as soon as it fails', async ({ page }) => {
    let serveRunning = true

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      const running = serveRunning
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-failed-filter-live-1',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Watch the failed filter while running',
              user_prompt: 'Watch the failed filter while running',
              session_id: 'sess-chat-run-failed-filter-live-1',
              status: running ? 'running' : 'done',
              exit_code: running ? null : 2,
              started_at: now() - 70,
              finished_at: running ? null : now() - 5,
              work_summary: running ? 'Still running outside the failed filter' : 'Failed filter filled live',
            }),
            makeJob({
              id: 'agent-run-existing-failure-1',
              project: AGENT_PROJECT,
              kind: 'agent:planner',
              prompt: 'Existing failed planner agent',
              user_prompt: 'Existing failed planner agent',
              status: 'done',
              exit_code: 1,
              started_at: now() - 140,
              finished_at: now() - 120,
              work_summary: 'Existing failure keeps the failed filter selectable',
            }),
          ],
          total: 2,
          pendingReleaseProjects: [],
        },
      })
    })

    await page.goto('/runs')

    const runningRow = runRow(page, RUN_PROJECT)
    const failedRow = runRow(page, AGENT_PROJECT)

    await expect(runningRow).toBeVisible({ timeout: 8_000 })
    await expect(runningRow.getByLabel('running')).toBeVisible()
    await expect(failedRow.getByLabel('needs attention')).toBeVisible()

    await filterChip(page, 'failed').click()
    await expect(failedRow).toBeVisible()
    await expect(failedRow.getByText('Existing failure keeps the failed filter selectable')).toBeVisible()
    await expect(runningRow).toHaveCount(0)

    serveRunning = false

    const newlyFailedRow = runRow(page, RUN_PROJECT)
    await expect(newlyFailedRow).toBeVisible({ timeout: 12_000 })
    await expect(newlyFailedRow.getByLabel('needs attention')).toBeVisible({ timeout: 12_000 })
    await expect(newlyFailedRow.getByText('exit 2', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(newlyFailedRow.getByText('Failed filter filled live')).toBeVisible({ timeout: 12_000 })
    await expect(newlyFailedRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(failedRow).toBeVisible()
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

    await filterChip(page, 'running').click()
    await expect(row).toBeVisible()
    await expect(page.getByText('Nothing is running right now')).toHaveCount(0)

    serveRunning = false

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByText('There is no active run in all projects right now.')).toBeVisible()
    await expect(row).toHaveCount(0)

    await filterChip(page, 'done').click()
    const doneRow = runRow(page, RUN_PROJECT)
    await expect(doneRow).toBeVisible()
    await expect(doneRow.getByLabel('done')).toBeVisible()
    await expect(doneRow.getByText('Live filter check complete')).toBeVisible()
  })

  test('project-scoped running filter clears to the scoped empty state and resets back to all projects', async ({ page }) => {
    let serveScopedRunning = true

    await stubRunsShellRoutes(page)
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === RUN_PROJECT,
      (route: Route) => {
        const running = serveScopedRunning
        route.fulfill({
          json: {
            jobs: [
              makeJob({
                id: 'chat-run-scoped-filter-1',
                project: RUN_PROJECT,
                kind: 'run',
                prompt: 'Watch the scoped running filter',
                user_prompt: 'Watch the scoped running filter',
                session_id: 'sess-chat-run-scoped-filter-1',
                status: running ? 'running' : 'done',
                exit_code: running ? null : 0,
                started_at: now() - 65,
                finished_at: running ? null : now() - 5,
                work_summary: running ? 'Scoped run still active' : 'Scoped run finished cleanly',
              }),
            ],
            total: 1,
            pendingReleaseProjects: [],
          },
        })
      },
    )
    await page.route(
      (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
      (route: Route) => {
        const running = serveScopedRunning
        route.fulfill({
          json: {
            jobs: [
              makeJob({
                id: 'chat-run-global-steady-1',
                project: OTHER_PROJECT,
                kind: 'run',
                prompt: 'Keep a global run active',
                user_prompt: 'Keep a global run active',
                session_id: 'sess-chat-run-global-steady-1',
                status: 'running',
                exit_code: null,
                started_at: now() - 40,
                finished_at: null,
                work_summary: 'Other project still has active work',
              }),
              makeJob({
                id: 'chat-run-scoped-filter-1',
                project: RUN_PROJECT,
                kind: 'run',
                prompt: 'Watch the scoped running filter',
                user_prompt: 'Watch the scoped running filter',
                session_id: 'sess-chat-run-scoped-filter-1',
                status: running ? 'running' : 'done',
                exit_code: running ? null : 0,
                started_at: now() - 65,
                finished_at: running ? null : now() - 5,
                work_summary: running ? 'Scoped run still active' : 'Scoped run finished cleanly',
              }),
            ],
            total: 2,
            pendingReleaseProjects: [],
          },
        })
      },
    )
    await page.route(
      (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === RUN_PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            total: 1,
            byKind: { run: 1 },
            byStatus: {
              running: serveScopedRunning ? 1 : 0,
              done: serveScopedRunning ? 0 : 1,
              aborted: 0,
              failed: 0,
            },
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
            cost: { total: 0, monthToDate: 0 },
          },
        }),
    )
    await page.route(
      (url) => url.pathname === '/api/jobs/counts' && !url.searchParams.has('project'),
      (route: Route) =>
        route.fulfill({
          json: {
            total: 2,
            byKind: { run: 2 },
            byStatus: {
              running: serveScopedRunning ? 2 : 1,
              done: serveScopedRunning ? 0 : 1,
              aborted: 0,
              failed: 0,
            },
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
            cost: { total: 0, monthToDate: 0 },
          },
        }),
    )

    await page.goto(`/runs?project=${encodeURIComponent(RUN_PROJECT)}`)

    await expect(
      page.getByRole('combobox', { name: 'Filter runs by project' }),
    ).toHaveValue(RUN_PROJECT)

    const scopedRow = page.getByRole('button').filter({
      hasText: 'Watch the scoped running filter',
    }).first()
    await expect(scopedRow).toBeVisible({ timeout: 8_000 })
    await expect(scopedRow.getByLabel('running')).toBeVisible()

    await filterChip(page, 'running').click()
    await expect(scopedRow.getByText('Scoped run still active')).toBeVisible()

    serveScopedRunning = false

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByText(`There is no active run in ${RUN_PROJECT} right now.`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show all projects' })).toBeVisible()

    await page.getByRole('button', { name: 'Show all projects' }).click()

    const otherRow = runRow(page, OTHER_PROJECT)
    await expect(otherRow).toBeVisible({ timeout: 12_000 })
    await expect(otherRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(otherRow.getByText('Other project still has active work')).toBeVisible()
    await expect(page).toHaveURL(/\/runs$/)
  })

  test('active done filter populates when a running chat run completes', async ({ page }) => {
    let serveRunning = true

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      const running = serveRunning
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-done-filter-live-1',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Wait for the done filter to fill',
              user_prompt: 'Wait for the done filter to fill',
              session_id: 'sess-chat-run-done-filter-live-1',
              status: running ? 'running' : 'done',
              exit_code: running ? null : 0,
              started_at: now() - 75,
              finished_at: running ? null : now() - 5,
              work_summary: running ? 'Still running before filter switch' : 'Done filter filled live',
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

    await filterChip(page, 'done').click()
    await expect(page.getByText('No completed runs in view')).toBeVisible()
    await expect(page.getByText('The current view only contains running or attention-needed work.')).toBeVisible()
    await expect(row).toHaveCount(0)

    serveRunning = false

    const doneRow = runRow(page, RUN_PROJECT)
    await expect(doneRow).toBeVisible({ timeout: 12_000 })
    await expect(doneRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(doneRow.getByText('Done filter filled live')).toBeVisible({ timeout: 12_000 })
    await expect(doneRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
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

  test('agent row flips from running to failed without disturbing a concurrent chat run', async ({ page }) => {
    let pollCount = 0

    await stubRunsShellRoutes(page)
    await page.route('**/api/jobs?limit=200', (route: Route) => {
      pollCount += 1
      const agentFailed = pollCount >= 2
      route.fulfill({
        json: {
          jobs: [
            makeJob({
              id: 'chat-run-live-steady-2',
              project: RUN_PROJECT,
              kind: 'run',
              prompt: 'Keep watching the release queue',
              user_prompt: 'Keep watching the release queue',
              session_id: 'sess-chat-run-live-steady-2',
              status: 'running',
              exit_code: null,
              started_at: now() - 90,
              finished_at: null,
              work_summary: 'Waiting for the next run to finish',
            }),
            makeJob({
              id: 'agent-run-live-fail-1',
              project: AGENT_PROJECT,
              kind: 'agent:planner',
              prompt: 'Planner agent',
              user_prompt: 'Planner agent',
              status: agentFailed ? 'done' : 'running',
              exit_code: agentFailed ? 2 : null,
              started_at: now() - 45,
              finished_at: agentFailed ? now() - 6 : null,
              work_summary: agentFailed ? 'Planner hit a hard failure during drafting' : 'Drafting next actions',
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
    await expect(agentRow.getByText('exit 2', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(agentRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(agentRow.getByText('Planner hit a hard failure during drafting')).toBeVisible({
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
    await expect(page.getByText(/0 total runs/).first()).toBeVisible()
    await expect(runRow(page, RUN_PROJECT)).toHaveCount(0)

    serveRunning = true

    const row = runRow(page, RUN_PROJECT)
    await expect(row).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toBeVisible()
    await expect(row.getByText('New run just started')).toBeVisible()

    await expect(page.getByText(/1 total run .* 1 running/)).toBeVisible({
      timeout: 20_000,
    })
    await expect(filterChip(page, 'running')).toHaveText(/^running 1$/i)
    await expect(page.getByText('No runs yet')).toHaveCount(0)
  })
})
