import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// NotificationBell UI tests — verify unread badge count, running pulse dot,
// dropdown sections, "Clear all", and auto-poll updates using mocked API.
// All tests use the port 1338 test server; no real pipeline execution.

const now = () => Math.floor(Date.now() / 1000);

type NotifJob = {
  id: string;
  kind: string;
  project: string;
  status: 'running' | 'done';
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  verdict: string | null;
  session_id: string | null;
  prompt: null;
  user_prompt: null;
  context_meta: null;
  parent_kind: string | null;
  parent_job_id: string | null;
};

function makeNotifJob(
  overrides: Partial<NotifJob> & Pick<NotifJob, 'id' | 'project' | 'kind' | 'status' | 'exit_code' | 'finished_at'>,
): NotifJob {
  return {
    started_at: now() - 120,
    verdict: null,
    session_id: null,
    prompt: null,
    user_prompt: null,
    context_meta: null,
    parent_kind: null,
    parent_job_id: null,
    ...overrides,
  };
}

// Minimal stubs needed to render the /runs page without real API calls.
async function stubShellRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
}

test.describe('NotificationBell', () => {
  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------
  test('shows "All caught up" message when there are no notifications', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
    );

    await page.goto('/runs');

    const bellBtn = page.getByTitle('No notifications');
    await expect(bellBtn).toBeVisible({ timeout: 8_000 });

    await bellBtn.click();
    await expect(page.getByText('All caught up')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Notifications')).toBeVisible();
    // No "Clear all" when there's nothing to clear
    await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Red badge showing the per-project collapsed finished-job count
  // -------------------------------------------------------------------------
  test('shows red unread badge with the finished-job count', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({
        json: {
          count: 2,
          jobs: [
            makeNotifJob({ id: 'f1', project: 'alpha', kind: 'push', status: 'done', exit_code: 0, finished_at: now() - 60 }),
            makeNotifJob({ id: 'f2', project: 'beta', kind: 'test', status: 'done', exit_code: 1, finished_at: now() - 30 }),
          ],
          runningCount: 0,
          runningJobs: [],
        },
      }),
    );

    await page.goto('/runs');

    // Button title reflects unseenCount=2
    const bellBtn = page.getByTitle('2 unread');
    await expect(bellBtn).toBeVisible({ timeout: 8_000 });
    // Badge span inside the button shows the collapsed per-project count
    const badge = bellBtn.locator('span.bg-status-error');
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(badge).toHaveText('2');
  });

  // -------------------------------------------------------------------------
  // Blue pulse dot when running jobs but no unseen finished jobs
  // -------------------------------------------------------------------------
  test('shows blue pulse dot on bell when running jobs are present but no finished jobs', async ({
    page,
  }) => {
    await stubShellRoutes(page);
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({
        json: {
          count: 0,
          jobs: [],
          runningCount: 1,
          runningJobs: [
            makeNotifJob({ id: 'r1', project: 'gamma', kind: 'review', status: 'running', exit_code: null, finished_at: null }),
          ],
        },
      }),
    );

    await page.goto('/runs');

    // Bell title reflects 1 running, no unread
    const bellBtn = page.getByTitle('1 running');
    await expect(bellBtn).toBeVisible({ timeout: 8_000 });
    // Pulse dot (animate-pulse) appears inside the button when isRunning && no finished
    await expect(bellBtn.locator('span.animate-pulse')).toBeVisible({ timeout: 5_000 });
    // No red badge (finishedJobs.length === 0)
    await expect(bellBtn.locator('span.bg-status-error')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Dropdown — Running section content
  // -------------------------------------------------------------------------
  test('dropdown shows Running section header and project name for running jobs', async ({
    page,
  }) => {
    await stubShellRoutes(page);
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({
        json: {
          count: 0,
          jobs: [],
          runningCount: 1,
          runningJobs: [
            makeNotifJob({ id: 'r1', project: 'running-project', kind: 'review', status: 'running', exit_code: null, finished_at: null }),
          ],
        },
      }),
    );

    await page.goto('/runs');

    await page.getByTitle('1 running').click();

    await expect(page.getByText('Notifications')).toBeVisible({ timeout: 5_000 });
    // Section header "Running · 1 project" (CSS uppercase is visual-only; DOM text is mixed case)
    await expect(page.getByText(/running.*1 project/i)).toBeVisible();
    await expect(page.getByText('running-project')).toBeVisible();
    // No "Clear all" when there are no finished jobs
    await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Dropdown — success icon for a passing push job
  // -------------------------------------------------------------------------
  test('dropdown shows success icon for a finished push job with exit_code=0', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({
        json: {
          count: 1,
          jobs: [
            makeNotifJob({ id: 'f1', project: 'success-project', kind: 'push', status: 'done', exit_code: 0, finished_at: now() - 60 }),
          ],
          runningCount: 0,
          runningJobs: [],
        },
      }),
    );

    await page.goto('/runs');

    await page.getByTitle('1 unread').click();

    await expect(page.getByText('success-project')).toBeVisible({ timeout: 5_000 });
    // StatusIcon renders aria-label="success" on the SVG for successful jobs
    await expect(page.locator('[aria-label="success"]').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Dropdown — attention icon and verdict badge for a failed review
  // -------------------------------------------------------------------------
  test('dropdown shows attention icon and "do not ship" verdict for a DO NOT SHIP review', async ({
    page,
  }) => {
    await stubShellRoutes(page);
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({
        json: {
          count: 1,
          jobs: [
            makeNotifJob({
              id: 'f1',
              project: 'fail-project',
              kind: 'review',
              status: 'done',
              exit_code: 0,
              finished_at: now() - 60,
              verdict: 'DO NOT SHIP',
            }),
          ],
          runningCount: 0,
          runningJobs: [],
        },
      }),
    );

    await page.goto('/runs');

    await page.getByTitle('1 unread').click();

    await expect(page.getByText('fail-project')).toBeVisible({ timeout: 5_000 });
    // StatusIcon renders aria-label="attention" on the SVG when success=false
    await expect(page.locator('[aria-label="attention"]').first()).toBeVisible();
    // VerdictBadge renders "do not ship" for DO NOT SHIP verdict
    await expect(page.getByText('do not ship').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // "Clear all" immediately removes badge and switches to "All caught up"
  // -------------------------------------------------------------------------
  test('"Clear all" removes the unread badge and shows "All caught up" without reload', async ({
    page,
  }) => {
    await stubShellRoutes(page);
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({
        json: {
          count: 1,
          jobs: [
            makeNotifJob({ id: 'c1', project: 'clear-project', kind: 'push', status: 'done', exit_code: 0, finished_at: now() - 60 }),
          ],
          runningCount: 0,
          runningJobs: [],
        },
      }),
    );
    await page.route('**/api/jobs/notifications/mark-seen', (route: Route) =>
      route.fulfill({ json: { status: 'ok', marked: 1 } }),
    );

    await page.goto('/runs');

    const bellBtn = page.getByTitle('1 unread');
    await expect(bellBtn).toBeVisible({ timeout: 8_000 });

    await bellBtn.click();
    await expect(page.getByRole('button', { name: 'Clear all' })).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Clear all' }).click();

    // After clear: state updates synchronously — badge disappears, "All caught up" appears
    await expect(page.getByTitle('No notifications')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('All caught up')).toBeVisible({ timeout: 5_000 });
    await expect(bellBtn.locator('span.bg-status-error')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Auto-poll: badge count updates when new notifications arrive
  // -------------------------------------------------------------------------
  test('badge count updates on 5s auto-poll when new finished jobs arrive', async ({ page }) => {
    let count = 0;
    let jobs: NotifJob[] = [];

    await stubShellRoutes(page);
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({ json: { count, jobs, runningCount: 0, runningJobs: [] } }),
    );

    await page.goto('/runs');

    // Initially empty — no badge
    await expect(page.getByTitle('No notifications')).toBeVisible({ timeout: 8_000 });

    // Flip mock to return one finished job
    count = 1;
    jobs = [
      makeNotifJob({ id: 'p1', project: 'poll-project', kind: 'push', status: 'done', exit_code: 0, finished_at: now() - 5 }),
    ];

    // Bell polls every 5 s — wait up to 12 s for badge to appear
    await expect(page.getByTitle('1 unread')).toBeVisible({ timeout: 12_000 });
  });

  test('badge clears on 5s auto-poll when finished notifications disappear', async ({ page }) => {
    let count = 1;
    let jobs: NotifJob[] = [
      makeNotifJob({
        id: 'resolved-1',
        project: 'resolved-project',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        finished_at: now() - 5,
      }),
    ];

    await stubShellRoutes(page);
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({ json: { count, jobs, runningCount: 0, runningJobs: [] } }),
    );

    await page.goto('/runs');

    const bellBtn = page.getByTitle('1 unread');
    await expect(bellBtn).toBeVisible({ timeout: 8_000 });
    await expect(bellBtn.locator('span.bg-status-error')).toHaveText('1');

    count = 0;
    jobs = [];

    await expect(page.getByTitle('No notifications')).toBeVisible({ timeout: 12_000 });
    await expect(bellBtn.locator('span.bg-status-error')).toHaveCount(0);
  });
});
