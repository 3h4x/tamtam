import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for the project-overview StatusStrip *Tests* card. Unlike
// the CI card (task-level data from /api/projects), the Tests card is derived
// from /api/jobs: `isTestRunning` (a running `test` job) and `latestTest` (the
// latest finished `test` job). This drives the 5s jobs poll by flipping the
// stubbed jobs payload, covering the lifecycle transitions that had no e2e:
//   1. no test jobs        -> "Tests not run yet" (neutral, not clickable)
//   2. a running test job  -> "Tests running starting" (warning, pulse)
//   3. test done exit 0    -> "Tests Passed" (success, clickable -> opens job)
//   4. test done exit 1    -> "Tests Failed (exit 1)" (error, clickable)

const PROJECT = 'status-strip-tests-ui';
const now = () => Math.floor(Date.now() / 1000);

function makeTask(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function makeTestJob(
  status: 'running' | 'done',
  exitCode: number | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'test-job-1',
    project: PROJECT,
    kind: 'test',
    status,
    exit_code: exitCode,
    started_at: now() - 30,
    finished_at: status === 'done' ? now() - 3 : null,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  };
}

async function stubOverviewRoutes(
  page: Page,
  opts: { jobs: () => Array<Record<string, unknown>> },
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask()], priorities: [], issueCounts: {} },
    }),
  );
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
          tests_disabled: false,
          review_disabled: false,
          issue_auto_branch: false,
        },
      }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/issues?summary=1`,
    (route: Route) =>
      route.fulfill({
        json: {
          repo: '',
          issueCount: 0,
          prCount: 0,
          openPrBranches: [],
          error: null,
          cached: true,
          cachedAt: Date.now(),
        },
      }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/branch`,
    (route: Route) =>
      route.fulfill({
        json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 },
      }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: { settings: { jobs_paused: 'false' }, github_owner: '' },
    }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: { jobs: opts.jobs(), pendingReleaseProjects: [] },
      }),
  );
}

test.describe('Overview StatusStrip Tests card lifecycle', () => {
  test('advances from running to Passed without reload', async ({ page }) => {
    let testRunning = true;
    await stubOverviewRoutes(page, {
      jobs: () =>
        testRunning
          ? [makeTestJob('running', null)]
          : [makeTestJob('done', 0)],
    });

    await page.goto(`/project/${PROJECT}`);
    const stablePath = new URL(page.url()).pathname;

    // A running test job with no prior finished test -> "running" + "starting".
    const running = page.getByRole('button', { name: /Tests\s+running\s+starting/i });
    await expect(running).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /Tests\s+Passed/i })).toHaveCount(0);

    // Job finishes exit 0 -> the 5s jobs poll flips the card to Passed (clickable).
    testRunning = false;

    const passed = page.getByRole('button', { name: /Tests\s+Passed/i });
    await expect(passed).toBeVisible({ timeout: 12_000 });
    await expect(passed).toBeEnabled();
    await expect(page.getByRole('button', { name: /Tests\s+running/i })).toHaveCount(0);
    // No client-side navigation happened during the live transition.
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath);
  });

  test('shows Failed (exit 1) when the test job finishes non-zero', async ({ page }) => {
    let testRunning = true;
    await stubOverviewRoutes(page, {
      jobs: () =>
        testRunning
          ? [makeTestJob('running', null)]
          : [makeTestJob('done', 1)],
    });

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByRole('button', { name: /Tests\s+running/i })).toBeVisible({
      timeout: 8_000,
    });

    testRunning = false;

    await expect(page.getByRole('button', { name: /Tests\s+Failed \(exit 1\)/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /Tests\s+Passed/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Tests\s+running/i })).toHaveCount(0);
  });
});
