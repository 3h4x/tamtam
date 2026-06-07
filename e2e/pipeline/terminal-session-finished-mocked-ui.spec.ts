import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

const PROJECT = 'terminal-session-finished-mocked'
const SESSION_ID = 'session-finished-mocked-1'
const PREVIOUS_JOB_ID = 'session-finished-prev-1'
const CURRENT_JOB_ID = 'session-finished-current-1'

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

function failedSessionJob() {
  return {
    id: CURRENT_JOB_ID,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: 2,
    started_at: now() - 40,
    finished_at: now() - 1,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: SESSION_ID,
    user_prompt: 'Finish the final pass even if the provider fails.',
    prompt: 'Finish the final pass even if the provider fails.',
    context_meta: null,
    provider: 'claude',
  }
}

function cancelledSessionJob() {
  return {
    id: CURRENT_JOB_ID,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: -2,
    started_at: now() - 40,
    finished_at: now() - 1,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: SESSION_ID,
    user_prompt: 'Restore the interrupted terminal run.',
    prompt: 'Restore the interrupted terminal run.',
    context_meta: null,
    provider: 'claude',
  }
}

async function stubTerminalShell(page: Page, jobsForProject: () => unknown[]): Promise<void> {
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
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  )
}

test.describe('Canonical terminal session route finished restore', () => {
  test('finished failed session restores its prompt, failure badge, and provider detail without reviving live state', async ({
    page,
  }) => {
    await stubTerminalShell(page, () => [previousSessionJob(), failedSessionJob()])
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
        json: {
          ...failedSessionJob(),
          log: 'Final streamed output failed before the restored session loaded.\n',
          detail: 'Mock provider failed during finished-session restore',
        },
      }),
    )

    await page.goto(`/project/${PROJECT}/terminal/${SESSION_ID}`)

    await expect(page.getByText('Earlier terminal output is restored.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('Finish the final pass even if the provider fails.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(
      page.getByText('Final streamed output failed before the restored session loaded.'),
    ).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('claude run failed')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Mock provider failed during finished-session restore')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('live run')).toHaveCount(0)
  })

  test('finished cancelled session restores its prompt and cancelled badge without reviving live state', async ({
    page,
  }) => {
    await stubTerminalShell(page, () => [previousSessionJob(), cancelledSessionJob()])
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
        json: {
          ...cancelledSessionJob(),
          log: 'Final streamed output was interrupted before the restored session loaded.\n',
          detail: 'Operator cancelled the finished restored session',
        },
      }),
    )

    await page.goto(`/project/${PROJECT}/terminal/${SESSION_ID}`)

    await expect(page.getByText('Earlier terminal output is restored.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('Restore the interrupted terminal run.')).toBeVisible({
      timeout: 8_000,
    })
    await expect(
      page.getByText('Final streamed output was interrupted before the restored session loaded.'),
    ).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText('exit -2')).toHaveCount(0)
    await expect(page.getByText('live run')).toHaveCount(0)
  })
})
