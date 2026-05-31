import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'history-nonrelease-live'

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

function makeJob(
  overrides: Partial<MockJob> &
    Pick<
      MockJob,
      | 'id'
      | 'kind'
      | 'prompt'
      | 'user_prompt'
      | 'work_summary'
      | 'session_id'
      | 'status'
      | 'exit_code'
      | 'started_at'
      | 'finished_at'
    >,
): MockJob {
  return {
    project: PROJECT,
    seen: true,
    pid: 0,
    log_path: '',
    ...overrides,
  }
}

function runRow(page: Page, text: string) {
  return page.getByRole('button').filter({ hasText: text }).first()
}

function filterChip(page: Page, label: 'running' | 'failed' | 'all') {
  return page.getByRole('button', { name: new RegExp(`^${label} \\d+$`, 'i') }).first()
}

async function stubHistoryShell(page: Page, jobs: () => MockJob[]): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [makeTask(PROJECT)],
        priorities: [],
        issueCounts: {},
      },
    }),
  )
  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) =>
      route.fulfill({
        json: {
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
          tests_disabled: true,
          review_disabled: false,
          issue_auto_branch: false,
        },
      }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({
      json: { branch: 'master', defaultBranch: 'master', commitsAhead: null },
    }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  )
  await page.route(
    (url) =>
      url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  )
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const currentJobs = jobs()
      route.fulfill({
        json: {
          jobs: currentJobs,
          total: currentJobs.length,
          pendingReleaseProjects: [],
        },
      })
    },
  )
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const currentJobs = jobs()
      const running = currentJobs.filter((job) => job.status === 'running').length
      const failed = currentJobs.filter(
        (job) => job.exit_code !== null && job.exit_code !== 0,
      ).length
      const byKind = currentJobs.reduce<Record<string, number>>((acc, job) => {
        acc[job.kind] = (acc[job.kind] ?? 0) + 1
        return acc
      }, {})
      route.fulfill({
        json: {
          total: currentJobs.length,
          byKind,
          byStatus: {
            running,
            done: currentJobs.filter((job) => job.status === 'done').length,
            aborted: 0,
            failed,
          },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      })
    },
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
}

test.describe('History tab non-release live polling', () => {
  test('history list picks up a newly-started chat run without reload', async ({ page }) => {
    let serveRunning = false

    await stubHistoryShell(page, () =>
      serveRunning
        ? [
            makeJob({
              id: 'chat-run-live-start-1',
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
    )

    await page.goto(`/project/${PROJECT}/history`)

    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 8_000 })
    await expect(
      page.getByText('Start work from Terminal or trigger a release.'),
    ).toBeVisible()
    await expect(runRow(page, 'Watch for a newly-started job')).toHaveCount(0)

    serveRunning = true

    const row = runRow(page, 'Watch for a newly-started job')
    await expect(row).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(row.getByText('Bootstrapping the live run')).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('No runs yet')).toHaveCount(0)
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 })
  })

  test('running filter repopulates when a new chat run starts after the list goes idle', async ({
    page,
  }) => {
    let serveRunning = true

    await stubHistoryShell(page, () => [
      makeJob({
        id: 'chat-run-running-filter-1',
        kind: 'run',
        prompt: 'Watch the running filter wake up',
        user_prompt: 'Watch the running filter wake up',
        session_id: 'sess-chat-run-running-filter-1',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 6,
        finished_at: serveRunning ? null : now() - 1,
        work_summary: serveRunning
          ? 'Fresh live work appeared while the running filter was active'
          : 'The running filter is empty because this chat run already finished',
      }),
    ])

    await page.goto(`/project/${PROJECT}/history`)

    const row = runRow(page, 'Watch the running filter wake up')
    await expect(row).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 12_000 })

    await filterChip(page, 'running').click()
    await expect(filterChip(page, 'running')).toHaveText(/running 1/i, {
      timeout: 12_000,
    })

    serveRunning = false

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    })
    await expect(
      page.getByText('This project has no active terminal, agent, or pipeline work at the moment.'),
    ).toBeVisible()
    await expect(runRow(page, 'Watch the running filter wake up')).toHaveCount(0)

    serveRunning = true

    await expect(row).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(
      row.getByText('Fresh live work appeared while the running filter was active'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(filterChip(page, 'running')).toHaveText(/running 1/i, {
      timeout: 12_000,
    })
  })

  test('chat run flips from running to exit 1 without reload and clears the live badge', async ({
    page,
  }) => {
    let serveRunning = true

    await stubHistoryShell(page, () => [
      makeJob({
        id: 'chat-run-failure-live-1',
        kind: 'run',
        prompt: 'Trigger a failing chat run',
        user_prompt: 'Trigger a failing chat run',
        session_id: 'sess-chat-run-failure-live-1',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 1,
        started_at: now() - 15,
        finished_at: serveRunning ? null : now() - 1,
        work_summary: serveRunning
          ? 'Streaming output before the provider aborts'
          : 'Provider exited before completing the requested work',
      }),
    ])

    await page.goto(`/project/${PROJECT}/history`)

    const row = runRow(page, 'Trigger a failing chat run')
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(row.getByText('Streaming output before the provider aborts')).toBeVisible({
      timeout: 8_000,
    })

    serveRunning = false

    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(
      row.getByText('Provider exited before completing the requested work'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
    await expect(filterChip(page, 'failed')).toHaveText(/failed 1/i, { timeout: 12_000 })
  })

  test('chat run flips from running to cancelled without reload and does not show a raw exit code', async ({
    page,
  }) => {
    let serveRunning = true

    await stubHistoryShell(page, () => [
      makeJob({
        id: 'chat-run-cancel-live-1',
        kind: 'run',
        prompt: 'Cancel a live chat run',
        user_prompt: 'Cancel a live chat run',
        session_id: 'sess-chat-run-cancel-live-1',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : -2,
        started_at: now() - 15,
        finished_at: serveRunning ? null : now() - 1,
        work_summary: serveRunning
          ? 'Waiting for the operator cancellation request'
          : 'Cancelled before the provider finished streaming output',
      }),
    ])

    await page.goto(`/project/${PROJECT}/history`)

    const row = runRow(page, 'Cancel a live chat run')
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(row.getByText('Waiting for the operator cancellation request')).toBeVisible({
      timeout: 8_000,
    })

    serveRunning = false

    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({
      timeout: 12_000,
    })
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(
      row.getByText('Cancelled before the provider finished streaming output'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(row.getByText('-2')).toHaveCount(0)
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
  })

  test('chat run and agent run keep independent live state as one finishes and the other keeps running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'chat-done' | 'all-done' = 'both-running'

    await stubHistoryShell(page, () => {
      const chatRun =
        phase === 'both-running'
          ? makeJob({
              id: 'chat-run-concurrent-1',
              kind: 'run',
              prompt: 'Summarize the diff while the planner keeps working',
              user_prompt: 'Summarize the diff while the planner keeps working',
              session_id: 'sess-chat-run-concurrent-1',
              status: 'running',
              exit_code: null,
              started_at: now() - 80,
              finished_at: null,
              work_summary: 'Chat run is still summarizing the current diff',
            })
          : makeJob({
              id: 'chat-run-concurrent-1',
              kind: 'run',
              prompt: 'Summarize the diff while the planner keeps working',
              user_prompt: 'Summarize the diff while the planner keeps working',
              session_id: 'sess-chat-run-concurrent-1',
              status: 'done',
              exit_code: 0,
              started_at: now() - 80,
              finished_at: now() - 10,
              work_summary: 'Chat run finished without interrupting the planner',
            })

      const plannerRun =
        phase === 'all-done'
          ? makeJob({
              id: 'planner-run-concurrent-1',
              kind: 'agent:release-planner',
              prompt: 'Draft the next release plan',
              user_prompt: 'Draft the next release plan',
              session_id: 'sess-planner-run-concurrent-1',
              status: 'done',
              exit_code: 0,
              started_at: now() - 60,
              finished_at: now() - 5,
              work_summary: 'Planner completed its release notes outline',
            })
          : makeJob({
              id: 'planner-run-concurrent-1',
              kind: 'agent:release-planner',
              prompt: 'Draft the next release plan',
              user_prompt: 'Draft the next release plan',
              session_id: 'sess-planner-run-concurrent-1',
              status: 'running',
              exit_code: null,
              started_at: now() - 60,
              finished_at: null,
              work_summary: 'Planner is still mapping the next release',
            })

      return [chatRun, plannerRun]
    })

    await page.goto(`/project/${PROJECT}/history`)

    const chatRow = runRow(page, 'Summarize the diff while the planner keeps working')
    const plannerRow = runRow(page, 'release-planner')

    await expect(chatRow).toBeVisible({ timeout: 8_000 })
    await expect(plannerRow).toBeVisible({ timeout: 8_000 })
    await expect(chatRow).not.toContainText('release-planner')
    await expect(plannerRow).not.toContainText('Summarize the diff while the planner keeps working')
    await expect(chatRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(plannerRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 8_000 })

    phase = 'chat-done'

    await expect(chatRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(chatRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(
      chatRow.getByText('Chat run finished without interrupting the planner'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(plannerRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(
      plannerRow.getByText('Planner is still mapping the next release'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 })

    phase = 'all-done'

    await expect(plannerRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(plannerRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(
      plannerRow.getByText('Planner completed its release notes outline'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
  })

  test('chat run failure does not clear a concurrent agent run that is still active', async ({
    page,
  }) => {
    let phase: 'both-running' | 'chat-failed' | 'all-done' = 'both-running'

    await stubHistoryShell(page, () => {
      const chatRun =
        phase === 'both-running'
          ? makeJob({
              id: 'chat-run-concurrent-failure-1',
              kind: 'run',
              prompt: 'Investigate the flaky provider output',
              user_prompt: 'Investigate the flaky provider output',
              session_id: 'sess-chat-run-concurrent-failure-1',
              status: 'running',
              exit_code: null,
              started_at: now() - 80,
              finished_at: null,
              work_summary: 'Chat run is still streaming provider output',
            })
          : makeJob({
              id: 'chat-run-concurrent-failure-1',
              kind: 'run',
              prompt: 'Investigate the flaky provider output',
              user_prompt: 'Investigate the flaky provider output',
              session_id: 'sess-chat-run-concurrent-failure-1',
              status: 'done',
              exit_code: 1,
              started_at: now() - 80,
              finished_at: now() - 10,
              work_summary: 'Provider exited before the chat run could finish',
            })

      const plannerRun =
        phase === 'all-done'
          ? makeJob({
              id: 'planner-run-concurrent-failure-1',
              kind: 'agent:release-planner',
              prompt: 'Keep planning while the chat run settles',
              user_prompt: 'Keep planning while the chat run settles',
              session_id: 'sess-planner-run-concurrent-failure-1',
              status: 'done',
              exit_code: 0,
              started_at: now() - 60,
              finished_at: now() - 5,
              work_summary: 'Planner finished after the failed chat run was recorded',
            })
          : makeJob({
              id: 'planner-run-concurrent-failure-1',
              kind: 'agent:release-planner',
              prompt: 'Keep planning while the chat run settles',
              user_prompt: 'Keep planning while the chat run settles',
              session_id: 'sess-planner-run-concurrent-failure-1',
              status: 'running',
              exit_code: null,
              started_at: now() - 60,
              finished_at: null,
              work_summary: 'Planner is still mapping follow-up work',
            })

      return [chatRun, plannerRun]
    })

    await page.goto(`/project/${PROJECT}/history`)

    const chatRow = runRow(page, 'Investigate the flaky provider output')
    const plannerRow = runRow(page, 'release-planner')

    await expect(chatRow).toBeVisible({ timeout: 8_000 })
    await expect(plannerRow).toBeVisible({ timeout: 8_000 })
    await expect(chatRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(plannerRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 8_000 })

    phase = 'chat-failed'

    await expect(chatRow.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(chatRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(
      chatRow.getByText('Provider exited before the chat run could finish'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(plannerRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(
      plannerRow.getByText('Planner is still mapping follow-up work'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 })
    await expect(filterChip(page, 'failed')).toHaveText(/failed 1/i, { timeout: 12_000 })

    phase = 'all-done'

    await expect(plannerRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(plannerRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(
      plannerRow.getByText('Planner finished after the failed chat run was recorded'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
    await expect(filterChip(page, 'failed')).toHaveText(/failed 1/i, { timeout: 12_000 })
  })

  test('agent cancellation does not clear a concurrent chat run that is still active', async ({
    page,
  }) => {
    let phase: 'both-running' | 'agent-cancelled' | 'all-done' = 'both-running'

    await stubHistoryShell(page, () => {
      const chatRun =
        phase === 'all-done'
          ? makeJob({
              id: 'chat-run-concurrent-cancel-1',
              kind: 'run',
              prompt: 'Finish the surviving chat run',
              user_prompt: 'Finish the surviving chat run',
              session_id: 'sess-chat-run-concurrent-cancel-1',
              status: 'done',
              exit_code: 0,
              started_at: now() - 80,
              finished_at: now() - 5,
              work_summary: 'Chat run completed after the agent cancellation',
            })
          : makeJob({
              id: 'chat-run-concurrent-cancel-1',
              kind: 'run',
              prompt: 'Finish the surviving chat run',
              user_prompt: 'Finish the surviving chat run',
              session_id: 'sess-chat-run-concurrent-cancel-1',
              status: 'running',
              exit_code: null,
              started_at: now() - 80,
              finished_at: null,
              work_summary: 'Chat run is still working through the requested task',
            })

      const plannerRun =
        phase === 'both-running'
          ? makeJob({
              id: 'planner-run-concurrent-cancel-1',
              kind: 'agent:release-planner',
              prompt: 'Abort this planner while the chat run keeps going',
              user_prompt: 'Abort this planner while the chat run keeps going',
              session_id: 'sess-planner-run-concurrent-cancel-1',
              status: 'running',
              exit_code: null,
              started_at: now() - 60,
              finished_at: null,
              work_summary: 'Planner is still active before the cancellation lands',
            })
          : makeJob({
              id: 'planner-run-concurrent-cancel-1',
              kind: 'agent:release-planner',
              prompt: 'Abort this planner while the chat run keeps going',
              user_prompt: 'Abort this planner while the chat run keeps going',
              session_id: 'sess-planner-run-concurrent-cancel-1',
              status: 'done',
              exit_code: -2,
              started_at: now() - 60,
              finished_at: now() - 10,
              work_summary: 'Planner was cancelled while the chat run kept running',
            })

      return [chatRun, plannerRun]
    })

    await page.goto(`/project/${PROJECT}/history`)

    const chatRow = runRow(page, 'Finish the surviving chat run')
    const plannerRow = runRow(page, 'release-planner')

    await expect(chatRow).toBeVisible({ timeout: 8_000 })
    await expect(plannerRow).toBeVisible({ timeout: 8_000 })
    await expect(chatRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(plannerRow.getByLabel('running')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 8_000 })

    phase = 'agent-cancelled'

    await expect(plannerRow.getByText('cancelled', { exact: true })).toBeVisible({
      timeout: 12_000,
    })
    await expect(plannerRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(
      plannerRow.getByText('Planner was cancelled while the chat run kept running'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(chatRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(
      chatRow.getByText('Chat run is still working through the requested task'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 })
    await expect(plannerRow.getByText('-2')).toHaveCount(0)

    phase = 'all-done'

    await expect(chatRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(chatRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(
      chatRow.getByText('Chat run completed after the agent cancellation'),
    ).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
  })
})
