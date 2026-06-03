import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'terminal-session-route-live'
const SESSION_ID = 'session-route-live-1'
const PREVIOUS_JOB_ID = 'session-route-prev-1'
const CURRENT_JOB_ID = 'session-route-current-1'

const now = () => Math.floor(Date.now() / 1000)

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

function previousSessionJob() {
  return {
    id: PREVIOUS_JOB_ID,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: 0,
    started_at: now() - 120,
    finished_at: now() - 90,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: SESSION_ID,
    user_prompt: 'Plan the first part of the change.',
    prompt: 'Plan the first part of the change.',
    context_meta: null,
    provider: 'claude',
  }
}

function runningSessionJob() {
  return {
    id: CURRENT_JOB_ID,
    project: PROJECT,
    kind: 'run',
    status: 'running',
    exit_code: null,
    started_at: now() - 30,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: SESSION_ID,
    user_prompt: 'Continue with the final terminal pass.',
    prompt: 'Continue with the final terminal pass.',
    context_meta: null,
    provider: 'claude',
  }
}

function finishedSessionJob(exitCode: number) {
  return {
    ...runningSessionJob(),
    status: 'done',
    exit_code: exitCode,
    finished_at: now() - 1,
  }
}

async function stubTerminalShell(
  page: Page,
  jobsForProject: () => unknown[],
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask()], priorities: [], issueCounts: {} },
    }),
  )
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  )
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  )
  await page.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  )
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  )
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  )
  await page.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') === '1',
    (route: Route) =>
      route.fulfill({
        json: {
          repo: '',
          prCount: 0,
          issueCount: 0,
          openPrBranches: [],
          error: null,
          cached: false,
          cachedAt: now(),
        },
      }),
  )
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: { jobs: jobsForProject(), pendingReleaseProjects: [] },
      }),
  )
}

test.describe('Canonical terminal session route lifecycle', () => {
  test('session route restores prior entries, streams the running step, and settles in place after success', async ({
    page,
  }) => {
    let serveRunningJob = true
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubTerminalShell(page, () => [
      previousSessionJob(),
      serveRunningJob ? runningSessionJob() : finishedSessionJob(0),
    ])
    await page.route(`**/api/jobs/${PREVIOUS_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: {
          ...previousSessionJob(),
          log: 'Earlier terminal output is restored.\n',
        },
      }),
    )
    await page.route(`**/api/jobs/${CURRENT_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningSessionJob()
          : {
              ...finishedSessionJob(0),
              log: 'Final streamed output finished successfully.\n',
            },
      }),
    )
    await page.route(`**/api/streaming/${CURRENT_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Final streamed output finished successfully.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            sessionId: SESSION_ID,
            provider: 'claude',
            duration: 1200,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal/${SESSION_ID}`)

    await expect(page.getByText('Earlier terminal output is restored.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('Continue with the final terminal pass.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })

    serveRunningJob = false
    finishStream()

    await expect(page.getByText('Final streamed output finished successfully.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}$`))
  })

  test('session route clears its live badge and shows provider failure details in place', async ({
    page,
  }) => {
    let serveRunningJob = true
    let finishStream!: () => void
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve
    })

    await stubTerminalShell(page, () => [
      previousSessionJob(),
      serveRunningJob ? runningSessionJob() : finishedSessionJob(2),
    ])
    await page.route(`**/api/jobs/${PREVIOUS_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: {
          ...previousSessionJob(),
          log: 'Earlier terminal output is restored.\n',
        },
      }),
    )
    await page.route(`**/api/jobs/${CURRENT_JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningSessionJob()
          : {
              ...finishedSessionJob(2),
              log: 'Final streamed output failed before the session settled.\n',
              detail: 'Mock provider failed during resumed session',
            },
      }),
    )
    await page.route(`**/api/streaming/${CURRENT_JOB_ID}`, async (route: Route) => {
      await streamDone
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Final streamed output failed before the session settled.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 2,
            sessionId: SESSION_ID,
            provider: 'claude',
            detail: 'Mock provider failed during resumed session',
            duration: 900,
          })}`,
          '',
        ].join('\n'),
      })
    })

    await page.goto(`/project/${PROJECT}/terminal/${SESSION_ID}`)

    await expect(page.getByText('Earlier terminal output is restored.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('Continue with the final terminal pass.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 })

    serveRunningJob = false
    finishStream()

    await expect(
      page.getByText('Final streamed output failed before the session settled.'),
    ).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Mock provider failed during resumed session')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 8_000 })
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}$`))
  })
})
