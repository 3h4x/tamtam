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
})
