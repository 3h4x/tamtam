import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Recommendations page UI tests — verify empty state, grouped item display,
// dismiss/accept actions that remove items without page reload, and load errors.
// All tests use page.route() mocking against port 1338; no real data writes.

const now = () => Math.floor(Date.now() / 1000);

type RecOverrides = Partial<{
  id: string;
  project: string;
  type: string;
  title: string;
  detail: string;
  agent_id: string | null;
  agent_name: string | null;
  payload: Record<string, unknown> | null;
}>;

function makeRec(overrides: RecOverrides = {}) {
  return {
    id: 'rec-1',
    project: 'my-project',
    source_kind: 'agent',
    source_id: null,
    agent_id: 'agent-1',
    agent_name: null,
    type: 'agent_schedule_backoff',
    title: 'Reduce run frequency',
    detail: 'Agent found no actionable work repeatedly.',
    status: 'open' as const,
    payload: { recommendedSchedule: '0 */6 * * *', currentSchedule: '0 * * * *' },
    created_at: now() - 3600,
    updated_at: now() - 3600,
    ...overrides,
  };
}

async function stubShellRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
}

test.describe('Recommendations page', () => {
  // ─── Empty state ─────────────────────────────────────────────────────────────
  test('shows "No open recommendations" when there are none', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/recommendations',
      (route: Route) => route.fulfill({ json: { recommendations: [] } }),
    );

    await page.goto('/recommendations');

    await expect(
      page.getByText('No open recommendations across any project.'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('0 open')).toBeVisible();
  });

  // ─── List display ─────────────────────────────────────────────────────────────
  test('groups items by project and shows total count', async ({ page }) => {
    const rec1 = makeRec({ id: 'r1', project: 'alpha', title: 'Alpha fix 1' });
    const rec2 = makeRec({ id: 'r2', project: 'alpha', title: 'Alpha fix 2' });
    const rec3 = makeRec({ id: 'r3', project: 'beta', title: 'Beta fix 1' });

    await stubShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/recommendations',
      (route: Route) =>
        route.fulfill({ json: { recommendations: [rec1, rec2, rec3] } }),
    );

    await page.goto('/recommendations');

    await expect(page.getByText('3 open')).toBeVisible({ timeout: 8_000 });

    // Both project section headings must appear
    await expect(page.getByRole('heading', { level: 2, name: 'alpha' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'beta' })).toBeVisible();

    // All item titles visible
    await expect(page.getByText('Alpha fix 1')).toBeVisible();
    await expect(page.getByText('Alpha fix 2')).toBeVisible();
    await expect(page.getByText('Beta fix 1')).toBeVisible();
  });

  // ─── Dismiss removes item without page reload ─────────────────────────────────
  test('dismiss removes the card immediately without reload', async ({ page }) => {
    // Use a non-auto-applicable type so the Accept button is absent — only
    // dismiss is rendered — making button targeting unambiguous.
    const stay = makeRec({ id: 'rec-stay', project: 'alpha', type: 'other_type', title: 'Stay here', agent_id: null });
    const gone = makeRec({ id: 'rec-gone', project: 'alpha', type: 'other_type', title: 'Goes away', agent_id: null });

    let loadCount = 0;
    await stubShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/recommendations',
      (route: Route) => {
        loadCount++;
        // First load returns both; re-load after dismiss returns only the remaining one.
        route.fulfill({
          json: {
            recommendations: loadCount === 1 ? [stay, gone] : [stay],
          },
        });
      },
    );

    // Intercept the PATCH dismiss call
    await page.route(
      (url) => url.pathname === '/api/projects/by-project/alpha/recommendations',
      (route: Route) => {
        if (route.request().method() === 'PATCH') {
          route.fulfill({ json: { recommendation: { ...gone, status: 'dismissed' } } });
        } else {
          route.continue();
        }
      },
    );

    await page.goto('/recommendations');

    await expect(page.getByText('Goes away')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('2 open')).toBeVisible();

    await page
      .getByRole('button', { name: /Dismiss recommendation.*Goes away/i })
      .click();

    // Item disappears immediately — no page reload
    await expect(page.getByText('Goes away')).not.toBeVisible({ timeout: 6_000 });
    await expect(page.getByText('Stay here')).toBeVisible();
    await expect(page.getByText('1 open')).toBeVisible();
  });

  // ─── Accept removes applicable item without page reload ──────────────────────
  test('Accept removes an agent_schedule_backoff recommendation without reload', async ({
    page,
  }) => {
    const rec = makeRec({
      id: 'rec-accept',
      project: 'gamma',
      title: 'Back off schedule',
      type: 'agent_schedule_backoff',
      agent_id: 'agent-gamma',
      payload: { recommendedSchedule: '0 */6 * * *', currentSchedule: '0 * * * *' },
    });

    let loadCount = 0;
    await stubShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/recommendations',
      (route: Route) => {
        loadCount++;
        route.fulfill({
          json: { recommendations: loadCount === 1 ? [rec] : [] },
        });
      },
    );

    await page.route(
      (url) =>
        url.pathname === '/api/projects/by-project/gamma/recommendations/apply',
      (route: Route) =>
        route.fulfill({ json: { recommendation: { ...rec, status: 'applied' } } }),
    );

    await page.goto('/recommendations');

    await expect(page.getByText('1 open')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Back off schedule')).toBeVisible();

    await page
      .getByRole('button', { name: /Accept recommendation.*Back off schedule/i })
      .click();

    // Card removed and empty state replaces it without reload
    await expect(
      page.getByText('No open recommendations across any project.'),
    ).toBeVisible({ timeout: 6_000 });
    await expect(page.getByText('0 open')).toBeVisible();
    await expect(page.getByText('Back off schedule')).not.toBeVisible();
  });

  // ─── Load error shows retry ───────────────────────────────────────────────────
  test('shows error message with Retry button when /api/recommendations fails', async ({
    page,
  }) => {
    let callCount = 0;
    await stubShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/recommendations',
      (route: Route) => {
        callCount++;
        if (callCount === 1) {
          route.fulfill({ status: 500, body: '{"detail":"internal error"}' });
        } else {
          route.fulfill({ json: { recommendations: [] } });
        }
      },
    );

    await page.goto('/recommendations');

    await expect(page.getByText('Failed to load recommendations.')).toBeVisible({
      timeout: 8_000,
    });
    const retryBtn = page.getByRole('button', { name: 'Retry' });
    await expect(retryBtn).toBeVisible();

    await retryBtn.click();

    // After successful retry the error clears and the empty state appears
    await expect(
      page.getByText('No open recommendations across any project.'),
    ).toBeVisible({ timeout: 6_000 });
    await expect(page.getByText('Failed to load recommendations.')).not.toBeVisible();
  });
});
