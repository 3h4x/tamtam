import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for the project-overview StatusStrip *Tests* card when a
// test cron schedule is configured. `testCronSchedule` is derived in OverviewTab
// as `config.test_cron_enabled ? config.test_cron_schedule : null`, and the
// StatusStrip threads it into three distinct render paths that every other strip
// spec leaves uncovered (all of them stub `test_cron_schedule: ''`):
//   1. no test jobs       -> "Tests not run yet" + detail "scheduled every 15m"
//   2. running, no prior  -> "starting" placeholder followed by " · auto every 15m"
//   3. test done exit 0   -> "Tests Passed ... · auto every 15m"
// This pins the cron-suffix wiring, including the running branch where the
// suffix renders as a sibling of the <StartingDetail/> fragment.

const PROJECT = 'status-strip-tests-cron-ui';
const SCHEDULE = '15m';
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
          test_cron_enabled: true,
          test_cron_schedule: SCHEDULE,
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

test.describe('Overview StatusStrip Tests card cron schedule', () => {
  test('neutral "not run yet" surfaces the scheduled-every detail', async ({ page }) => {
    await stubOverviewRoutes(page, { jobs: () => [] });

    await page.goto(`/project/${PROJECT}`);

    // No test jobs + cron enabled -> neutral card carrying the schedule.
    await expect(
      page.getByRole('button', { name: /Tests\s+not run yet\s+scheduled every 15m/i }),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('running with no prior run shows starting plus the auto-every suffix', async ({ page }) => {
    await stubOverviewRoutes(page, {
      jobs: () => [makeTestJob('running', null)],
    });

    await page.goto(`/project/${PROJECT}`);

    // Running branch with no finished test: <StartingDetail/> ("starting") and the
    // cron suffix render as siblings -> the accessible name carries both.
    await expect(
      page.getByRole('button', { name: /Tests\s+running\s+starting\s+·\s+auto every 15m/i }),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('finished Passed run appends the auto-every suffix and stays clickable', async ({ page }) => {
    let testRunning = true;
    await stubOverviewRoutes(page, {
      jobs: () =>
        testRunning ? [makeTestJob('running', null)] : [makeTestJob('done', 0)],
    });

    await page.goto(`/project/${PROJECT}`);

    await expect(
      page.getByRole('button', { name: /Tests\s+running/i }),
    ).toBeVisible({ timeout: 8_000 });

    // Job finishes exit 0 -> the 5s jobs poll flips to Passed with the cron suffix.
    testRunning = false;

    const passed = page.getByRole('button', {
      name: /Tests\s+Passed.*·\s+auto every 15m/i,
    });
    await expect(passed).toBeVisible({ timeout: 12_000 });
    await expect(passed).toBeEnabled();
  });
});
