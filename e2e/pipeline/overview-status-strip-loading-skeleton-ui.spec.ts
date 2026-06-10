import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for the project-overview StatusStrip *loading* state.
// `OverviewTab` passes `isLoading={!jobsLoaded}` to StatusStrip; `jobsLoaded`
// flips true only after the first /api/jobs poll resolves. Until then the strip
// renders four non-interactive skeleton placeholders (`.skeleton` blocks for
// Changes / Review / Tests / CI), NOT clickable StatusCard buttons. This proves
// the first-paint lifecycle: skeleton -> real cards on the same page, no reload,
// no orphaned skeleton once data arrives. No other spec gates the jobs response
// to assert the skeleton, so this transition had zero e2e coverage.

const PROJECT = 'status-strip-loading-ui';
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

function makeTestJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-job-1',
    project: PROJECT,
    kind: 'test',
    status: 'done',
    exit_code: 0,
    started_at: now() - 30,
    finished_at: now() - 3,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  };
}

async function stubOverviewRoutes(
  page: Page,
  opts: { jobsRoute: (route: Route) => void | Promise<void> },
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
    opts.jobsRoute,
  );
}

test.describe('Overview StatusStrip loading skeleton', () => {
  test('shows skeleton until jobs load, then swaps to real cards without reload', async ({
    page,
  }) => {
    // Gate the first /api/jobs response so the skeleton stays on screen long
    // enough to assert it. Resolving the gate lets the poll complete and flips
    // jobsLoaded -> true. Subsequent polls fulfill immediately.
    let releaseJobs: () => void = () => {};
    const jobsGate = new Promise<void>((resolve) => {
      releaseJobs = resolve;
    });
    let gated = true;

    await stubOverviewRoutes(page, {
      jobsRoute: async (route: Route) => {
        if (gated) {
          await jobsGate;
          gated = false;
        }
        await route.fulfill({
          json: { jobs: [makeTestJob()], pendingReleaseProjects: [] },
        });
      },
    });

    await page.goto(`/project/${PROJECT}`);
    const stablePath = new URL(page.url()).pathname;

    // While /api/jobs is pending, the strip renders skeleton placeholders.
    // There are four `.skeleton` dot blocks + four `.skeleton` text blocks (8),
    // and crucially NO interactive StatusCard button has surfaced yet.
    await expect(page.locator('.skeleton').first()).toBeVisible({ timeout: 8_000 });
    await expect.poll(() => page.locator('.skeleton').count()).toBeGreaterThanOrEqual(4);
    await expect(page.getByRole('button', { name: /Tests\s+Passed/i })).toHaveCount(0);

    // Let the jobs poll resolve -> jobsLoaded true -> real cards render.
    releaseJobs();

    const passed = page.getByRole('button', { name: /Tests\s+Passed/i });
    await expect(passed).toBeVisible({ timeout: 12_000 });
    await expect(passed).toBeEnabled();

    // The skeleton placeholders are gone and the swap happened in-place.
    await expect(page.locator('.skeleton')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Changes\s+clean/i })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath);
  });
});
