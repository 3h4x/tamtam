import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for the project-overview StatusStrip CI card. The CI
// state is task-level data from /api/projects, so this uses Playwright's clock
// to drive the app's 30s project poll deterministically instead of sleeping.

const PROJECT = 'status-strip-ci-ui';
const CI_URL = 'https://ci.example.test/runs/ci-card';
const now = () => Math.floor(Date.now() / 1000);

type CiState = 'success' | 'failure' | 'in_progress' | null;

function makeTask(ciState: CiState, overrides: Record<string, unknown> = {}) {
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
    ci: ciState,
    ci_failed_url: ciState ? CI_URL : null,
    github: null,
    ...overrides,
  };
}

async function stubOverviewRoutes(
  page: Page,
  opts: {
    task: () => Record<string, unknown>;
    jobs?: () => Array<Record<string, unknown>>;
  },
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/projects',
    (route: Route) =>
      route.fulfill({
        json: {
          tasks: [opts.task()],
          priorities: [],
          issueCounts: {},
        },
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
        json: {
          jobs: opts.jobs ? opts.jobs() : [],
          pendingReleaseProjects: [],
        },
      }),
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

test.describe('Overview StatusStrip CI lifecycle', () => {
  test('CI card advances from running to failing to passing without reload', async ({ page }) => {
    let ciState: CiState = 'in_progress';
    await page.clock.install({ time: new Date('2026-06-09T12:00:00Z') });
    await stubOverviewRoutes(page, {
      task: () =>
        makeTask(ciState, ciState === 'success' ? { release_tag: 'v1.2.3' } : {}),
    });

    await page.goto(`/project/${PROJECT}`);
    const stablePath = new URL(page.url()).pathname;

    await expect(page.getByRole('button', { name: /CI running open on GitHub/i })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: /CI failing/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /CI passing/i })).toHaveCount(0);

    ciState = 'failure';
    await advanceProjectPoll(page);

    await expect(page.getByRole('button', { name: /CI failing open on GitHub/i })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: /CI running/i })).toHaveCount(0);

    ciState = 'success';
    await advanceProjectPoll(page);

    await expect(page.getByRole('button', { name: /CI passing release v1\.2\.3/i })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: /CI failing/i })).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath);
  });

  test('CI card shows neutral "no status" when CI state is absent', async ({ page }) => {
    await stubOverviewRoutes(page, {
      task: () => makeTask(null),
    });

    await page.goto(`/project/${PROJECT}`);

    const card = page.getByRole('button', { name: /CI no status/i });
    await expect(card).toBeVisible({ timeout: 8_000 });
    // Neutral card has no run URL, so it is rendered non-interactive (disabled).
    await expect(card).toBeDisabled();
    await expect(page.getByRole('button', { name: /CI passing/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /CI failing/i })).toHaveCount(0);
  });

  test('CI passing falls back to "latest commit" detail when no release tag', async ({ page }) => {
    await stubOverviewRoutes(page, {
      task: () => makeTask('success', { release_tag: null }),
    });

    await page.goto(`/project/${PROJECT}`);

    await expect(
      page.getByRole('button', { name: /CI passing latest commit/i }),
    ).toBeVisible({ timeout: 8_000 });
    // With no release tag the CI detail must not render a "release <tag>" label.
    await expect(page.getByRole('button', { name: /CI passing release/i })).toHaveCount(0);
  });

  test('CI failing without a run URL shows "no run url" and is not clickable', async ({ page }) => {
    await stubOverviewRoutes(page, {
      task: () => makeTask('failure', { ci_failed_url: null }),
    });

    await page.goto(`/project/${PROJECT}`);

    const card = page.getByRole('button', { name: /CI failing no run url/i });
    await expect(card).toBeVisible({ timeout: 8_000 });
    // No URL means openCi is undefined, so the card is non-interactive.
    await expect(card).toBeDisabled();
    await expect(page.getByRole('button', { name: /open on GitHub/i })).toHaveCount(0);
  });

  test('CI failure opens the configured run URL from the card', async ({ page }) => {
    const openedUrls: string[] = [];
    await page.exposeFunction('recordOpenedUrl', (url: string) => {
      openedUrls.push(url);
    });
    await page.addInitScript(() => {
      window.open = ((url?: string | URL) => {
        void (window as unknown as { recordOpenedUrl: (url: string) => void }).recordOpenedUrl(
          String(url ?? ''),
        );
        return null;
      }) as typeof window.open;
    });

    await stubOverviewRoutes(page, {
      task: () => makeTask('failure'),
    });

    await page.goto(`/project/${PROJECT}`);

    await page.getByRole('button', { name: /CI failing open on GitHub/i }).click();
    await expect.poll(() => openedUrls).toEqual([CI_URL]);
  });
});
