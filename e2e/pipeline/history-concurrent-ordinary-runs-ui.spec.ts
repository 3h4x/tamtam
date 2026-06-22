import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'history-concurrent-ordinary-runs'

const now = () => Math.floor(Date.now() / 1000)

type MockJob = {
  id: string
  project: string
  kind: 'run'
  prompt: string
  user_prompt: string
  work_summary: string | null
  session_id: string
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

function makeRunJob(
  id: string,
  prompt: string,
  workSummary: string | null,
  overrides: Partial<MockJob> = {},
): MockJob {
  return {
    id,
    project: PROJECT,
    kind: 'run',
    prompt,
    user_prompt: prompt,
    work_summary: workSummary,
    session_id: `sess-${id}`,
    status: 'running',
    exit_code: null,
    started_at: now() - 45,
    finished_at: null,
    seen: true,
    pid: 0,
    log_path: '',
    ...overrides,
  }
}

function runRow(page: Page, prompt: string) {
  return page.getByRole('button').filter({ hasText: prompt }).first()
}

function runningRows(page: Page) {
  return page.getByRole('button').filter({ has: page.locator('[aria-label="running"]') })
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
      const done = currentJobs.filter((job) => job.status === 'done').length
      const failed = currentJobs.filter(
        (job) => typeof job.exit_code === 'number' && job.exit_code !== 0,
      ).length
      route.fulfill({
        json: {
          total: currentJobs.length,
          byKind: { run: currentJobs.length },
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
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
}

test.describe('History tab concurrent ordinary runs', () => {
  test('two live runs stay isolated when one succeeds and the other keeps running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'one-succeeded' | 'all-settled' = 'both-running'

    await stubHistoryShell(page, () => {
      if (phase === 'both-running') {
        return [
          makeRunJob(
            'ordinary-run-succeeded-peer',
            'Finish this peer run while the other keeps going.',
            'Preparing the final successful response.',
          ),
          makeRunJob(
            'ordinary-run-steady-success-peer',
            'Keep this peer run alive while the other finishes.',
            'Continuing useful work after the peer settles.',
            { started_at: now() - 20 },
          ),
        ]
      }

      if (phase === 'one-succeeded') {
        return [
          makeRunJob(
            'ordinary-run-succeeded-peer',
            'Finish this peer run while the other keeps going.',
            'Completed successfully before its peer finished.',
            {
              status: 'done',
              exit_code: 0,
              finished_at: now() - 2,
            },
          ),
          makeRunJob(
            'ordinary-run-steady-success-peer',
            'Keep this peer run alive while the other finishes.',
            'Still processing after the peer completed successfully.',
            { started_at: now() - 20 },
          ),
        ]
      }

      return [
        makeRunJob(
          'ordinary-run-succeeded-peer',
          'Finish this peer run while the other keeps going.',
          'Completed successfully before its peer finished.',
          {
            status: 'done',
            exit_code: 0,
            finished_at: now() - 5,
          },
        ),
        makeRunJob(
          'ordinary-run-steady-success-peer',
          'Keep this peer run alive while the other finishes.',
          'Completed after its peer already succeeded.',
          {
            status: 'done',
            exit_code: 0,
            finished_at: now() - 1,
          },
        ),
      ]
    })

    await page.goto(`/project/${PROJECT}/history`)

    const finishedRow = runRow(page, 'Finish this peer run while the other keeps going.')
    const steadyRow = runRow(page, 'Keep this peer run alive while the other finishes.')

    await expect(finishedRow).toBeVisible({ timeout: 8_000 })
    await expect(steadyRow).toBeVisible({ timeout: 8_000 })
    await expect(finishedRow.getByLabel('running')).toBeVisible()
    await expect(steadyRow.getByLabel('running')).toBeVisible()
    await expect(page.getByText('2 running')).toBeVisible()
    await expect(runningRows(page)).toHaveCount(2)

    phase = 'one-succeeded'

    await expect(finishedRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(finishedRow.getByText('Completed successfully before its peer finished.')).toBeVisible({
      timeout: 12_000,
    })
    await expect(finishedRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(steadyRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(
      steadyRow.getByText('Still processing after the peer completed successfully.'),
    ).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 })
    await expect(runningRows(page)).toHaveCount(1, { timeout: 12_000 })

    phase = 'all-settled'

    await expect(steadyRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(steadyRow.getByText('Completed after its peer already succeeded.')).toBeVisible({
      timeout: 12_000,
    })
    await expect(steadyRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
    await expect(runningRows(page)).toHaveCount(0, { timeout: 12_000 })
  })

  test('two live runs stay isolated when one is cancelled and the other keeps running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'one-cancelled' | 'all-settled' = 'both-running'

    await stubHistoryShell(page, () => {
      if (phase === 'both-running') {
        return [
          makeRunJob(
            'ordinary-run-cancelled-peer',
            'Cancel this peer run while the other keeps going.',
            'Waiting on a cancellation request.',
          ),
          makeRunJob(
            'ordinary-run-steady-peer',
            'Keep this peer run alive while the cancellation settles.',
            'Continuing to stream useful work.',
            { started_at: now() - 20 },
          ),
        ]
      }

      if (phase === 'one-cancelled') {
        return [
          makeRunJob(
            'ordinary-run-cancelled-peer',
            'Cancel this peer run while the other keeps going.',
            'The operator cancelled this run before completion.',
            {
              status: 'done',
              exit_code: -2,
              finished_at: now() - 2,
            },
          ),
          makeRunJob(
            'ordinary-run-steady-peer',
            'Keep this peer run alive while the cancellation settles.',
            'Still processing after the peer was cancelled.',
            { started_at: now() - 20 },
          ),
        ]
      }

      return [
        makeRunJob(
          'ordinary-run-cancelled-peer',
          'Cancel this peer run while the other keeps going.',
          'The operator cancelled this run before completion.',
          {
            status: 'done',
            exit_code: -2,
            finished_at: now() - 5,
          },
        ),
        makeRunJob(
          'ordinary-run-steady-peer',
          'Keep this peer run alive while the cancellation settles.',
          'Completed after its peer was cancelled.',
          {
            status: 'done',
            exit_code: 0,
            finished_at: now() - 1,
          },
        ),
      ]
    })

    await page.goto(`/project/${PROJECT}/history`)

    const cancelledRow = runRow(page, 'Cancel this peer run while the other keeps going.')
    const steadyRow = runRow(page, 'Keep this peer run alive while the cancellation settles.')

    await expect(cancelledRow).toBeVisible({ timeout: 8_000 })
    await expect(steadyRow).toBeVisible({ timeout: 8_000 })
    await expect(cancelledRow.getByLabel('running')).toBeVisible()
    await expect(steadyRow.getByLabel('running')).toBeVisible()
    await expect(page.getByText('2 running')).toBeVisible()
    await expect(runningRows(page)).toHaveCount(2)

    phase = 'one-cancelled'

    await expect(cancelledRow.getByText('cancelled', { exact: true })).toBeVisible({
      timeout: 12_000,
    })
    await expect(cancelledRow.getByText('The operator cancelled this run before completion.')).toBeVisible({
      timeout: 12_000,
    })
    await expect(cancelledRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(steadyRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(steadyRow.getByText('Still processing after the peer was cancelled.')).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 })
    await expect(runningRows(page)).toHaveCount(1, { timeout: 12_000 })

    phase = 'all-settled'

    await expect(steadyRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(steadyRow.getByText('Completed after its peer was cancelled.')).toBeVisible({
      timeout: 12_000,
    })
    await expect(steadyRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
    await expect(runningRows(page)).toHaveCount(0, { timeout: 12_000 })
  })

  test('two live runs stay isolated when one fails and the other keeps running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'one-failed' | 'all-settled' = 'both-running'

    await stubHistoryShell(page, () => {
      if (phase === 'both-running') {
        return [
          makeRunJob(
            'ordinary-run-failed-peer',
            'Fail this peer run while the other keeps going.',
            'Preparing a provider request that will fail.',
          ),
          makeRunJob(
            'ordinary-run-steady-failure-peer',
            'Keep this peer run alive while the failure surfaces.',
            'Continuing useful work while its peer is unstable.',
            { started_at: now() - 18 },
          ),
        ]
      }

      if (phase === 'one-failed') {
        return [
          makeRunJob(
            'ordinary-run-failed-peer',
            'Fail this peer run while the other keeps going.',
            'PROMPT ASSERTION FAILED: missing retrieval context',
            {
              status: 'done',
              exit_code: 1,
              finished_at: now() - 2,
            },
          ),
          makeRunJob(
            'ordinary-run-steady-failure-peer',
            'Keep this peer run alive while the failure surfaces.',
            'Still running after the peer failed.',
            { started_at: now() - 18 },
          ),
        ]
      }

      return [
        makeRunJob(
          'ordinary-run-failed-peer',
          'Fail this peer run while the other keeps going.',
          'PROMPT ASSERTION FAILED: missing retrieval context',
          {
            status: 'done',
            exit_code: 1,
            finished_at: now() - 6,
          },
        ),
        makeRunJob(
          'ordinary-run-steady-failure-peer',
          'Keep this peer run alive while the failure surfaces.',
          'Completed after the peer failure was handled.',
          {
            status: 'done',
            exit_code: 0,
            finished_at: now() - 1,
          },
        ),
      ]
    })

    await page.goto(`/project/${PROJECT}/history`)

    const failedRow = runRow(page, 'Fail this peer run while the other keeps going.')
    const steadyRow = runRow(page, 'Keep this peer run alive while the failure surfaces.')

    await expect(failedRow).toBeVisible({ timeout: 8_000 })
    await expect(steadyRow).toBeVisible({ timeout: 8_000 })
    await expect(failedRow.getByLabel('running')).toBeVisible()
    await expect(steadyRow.getByLabel('running')).toBeVisible()
    await expect(page.getByText('2 running')).toBeVisible()

    phase = 'one-failed'

    await expect(failedRow.getByText('exit 1').first()).toBeVisible({ timeout: 12_000 })
    await expect(failedRow.getByText('PROMPT ASSERTION FAILED: missing retrieval context')).toBeVisible({
      timeout: 12_000,
    })
    await expect(failedRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 })
    await expect(steadyRow.getByLabel('running')).toBeVisible({ timeout: 12_000 })
    await expect(steadyRow.getByText('Still running after the peer failed.')).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByRole('button', { name: /failed 1/i })).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 })
    await expect(runningRows(page)).toHaveCount(1, { timeout: 12_000 })

    phase = 'all-settled'

    await expect(steadyRow.getByLabel('done')).toBeVisible({ timeout: 12_000 })
    await expect(steadyRow.getByText('Completed after the peer failure was handled.')).toBeVisible({
      timeout: 12_000,
    })
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 })
    await expect(runningRows(page)).toHaveCount(0, { timeout: 12_000 })
  })
})
