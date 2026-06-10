import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for the project-overview StatusStrip *Changes* card. The
// card is derived entirely from task-level data on /api/projects (`changes` and
// `reviewed`), so this drives the app's 30s project poll with Playwright's clock
// rather than sleeping. It covers the lifecycle transitions that had no e2e:
//   1. changes=0                  -> "Changes clean" (success, NOT clickable)
//   2. changes>0, reviewed=false  -> "Changes N files unreviewed" (warning, clickable)
//   3. changes>0, reviewed=true   -> "Changes N files reviewed" (success, clickable)
// plus that clicking the card navigates to the project's changes tab.

const PROJECT = 'status-strip-changes-ui';

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

async function stubOverviewRoutes(
  page: Page,
  opts: { task: () => Record<string, unknown> },
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/projects',
    (route: Route) =>
      route.fulfill({
        json: { tasks: [opts.task()], priorities: [], issueCounts: {} },
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
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
}

async function advanceProjectPoll(page: Page): Promise<void> {
  const response = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.pathname === '/api/projects' && res.request().method() === 'GET';
  });
  await page.clock.runFor(30_000);
  await response;
}

test.describe('Overview StatusStrip Changes card lifecycle', () => {
  test('advances clean -> unreviewed -> reviewed without reload', async ({ page }) => {
    let task = makeTask();
    await page.clock.install({ time: new Date('2026-06-10T12:00:00Z') });
    await stubOverviewRoutes(page, { task: () => task });

    await page.goto(`/project/${PROJECT}`);
    const stablePath = new URL(page.url()).pathname;

    // 1. clean: a non-clickable success card.
    const clean = page.getByRole('button', { name: /Changes\s+clean\s+no uncommitted edits/i });
    await expect(clean).toBeVisible({ timeout: 8_000 });
    await expect(clean).toBeDisabled();
    await expect(page.getByRole('button', { name: /Changes\s+\d+ files?/i })).toHaveCount(0);

    // 2. work appears, not yet reviewed -> "3 files unreviewed", clickable.
    task = makeTask({ changes: 3, reviewed: false });
    await advanceProjectPoll(page);

    const unreviewed = page.getByRole('button', { name: /Changes\s+3 files\s+unreviewed/i });
    await expect(unreviewed).toBeVisible({ timeout: 8_000 });
    await expect(unreviewed).toBeEnabled();
    await expect(page.getByRole('button', { name: /Changes\s+clean/i })).toHaveCount(0);

    // 3. review passes -> "3 files reviewed", still clickable.
    task = makeTask({ changes: 3, reviewed: true });
    await advanceProjectPoll(page);

    const reviewed = page.getByRole('button', { name: /Changes\s+3 files\s+reviewed/i });
    await expect(reviewed).toBeVisible({ timeout: 8_000 });
    await expect(reviewed).toBeEnabled();
    await expect(page.getByRole('button', { name: /Changes\s+3 files\s+unreviewed/i })).toHaveCount(0);

    // No client-side navigation happened during the live transitions.
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath);
  });

  test('singular file label and click navigates to the changes tab', async ({ page }) => {
    await stubOverviewRoutes(page, {
      task: () => makeTask({ changes: 1, reviewed: false }),
    });

    await page.goto(`/project/${PROJECT}`);

    // Pluralization: exactly one file -> "1 file" (no trailing s).
    const card = page.getByRole('button', { name: /Changes\s+1 file\s+unreviewed/i });
    await expect(card).toBeVisible({ timeout: 8_000 });

    await card.click();

    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/project/${PROJECT}/changes`);
  });
});
