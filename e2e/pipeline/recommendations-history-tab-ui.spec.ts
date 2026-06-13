import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Recommendations History tab UI tests — lazy load, state chips (auto-resolved /
// dismissed / applied), empty state, and error/retry flow.
// All tests use page.route() mocking against port 1338; no real data writes.

const now = () => Math.floor(Date.now() / 1000);

type RecOverrides = Partial<{
  id: string;
  project: string;
  type: string;
  title: string;
  detail: string;
  status: string;
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
    status: 'open',
    payload: { recommendedSchedule: '0 */6 * * *', currentSchedule: '0 * * * *' },
    created_at: now() - 7200,
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

test.describe('Recommendations History tab', () => {
  // ─── Lazy load + state chips ─────────────────────────────────────────────────
  test('loads history lazily on first tab open and shows auto-resolved, dismissed, applied chips', async ({
    page,
  }) => {
    await stubShellRoutes(page);

    await page.route(
      (url) => url.pathname === '/api/recommendations' && !url.searchParams.has('state'),
      (route: Route) =>
        route.fulfill({ json: { recommendations: [makeRec({ id: 'open-1', title: 'Open rec' })] } }),
    );

    const historyItems = [
      makeRec({ id: 'h-1', status: 'resolved', title: 'Auto-resolved rec', type: 'agent_unfruitful' }),
      makeRec({ id: 'h-2', status: 'dismissed', title: 'Dismissed rec', type: 'orchestrator_agent_health' }),
      makeRec({ id: 'h-3', status: 'applied', title: 'Applied rec', type: 'agent_schedule_backoff' }),
    ];

    let historyCallCount = 0;
    await page.route(
      (url) => url.pathname === '/api/recommendations' && url.searchParams.get('state') === 'history',
      (route: Route) => {
        historyCallCount++;
        route.fulfill({ json: { recommendations: historyItems } });
      },
    );

    await page.goto('/recommendations');

    // Unresolved tab active; history endpoint not yet called
    await expect(page.getByRole('tab', { name: /Unresolved/i })).toBeVisible({ timeout: 8_000 });
    const historyTab = page.getByRole('tab', { name: /^History$/ });
    await expect(historyTab).toBeVisible();
    expect(historyCallCount).toBe(0);

    // Switch to History tab → lazy load fires
    await historyTab.click();

    await expect(page.getByText('Auto-resolved rec')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Dismissed rec')).toBeVisible();
    await expect(page.getByText('Applied rec')).toBeVisible();

    // State chips for each row (exact: true prevents substring matches on title text)
    await expect(page.getByText('auto-resolved', { exact: true })).toBeVisible();
    await expect(page.getByText('dismissed', { exact: true })).toBeVisible();
    await expect(page.getByText('applied', { exact: true })).toBeVisible();

    // Tab label updates to show loaded count
    await expect(page.getByRole('tab', { name: /History \(3\)/ })).toBeVisible();

    expect(historyCallCount).toBe(1);
  });

  // ─── Does not reload on repeated tab visits ───────────────────────────────────
  test('does not re-fetch history on repeated tab switches', async ({ page }) => {
    await stubShellRoutes(page);

    await page.route(
      (url) => url.pathname === '/api/recommendations' && !url.searchParams.has('state'),
      (route: Route) => route.fulfill({ json: { recommendations: [] } }),
    );

    let historyCallCount = 0;
    await page.route(
      (url) => url.pathname === '/api/recommendations' && url.searchParams.get('state') === 'history',
      (route: Route) => {
        historyCallCount++;
        route.fulfill({
          json: {
            recommendations: [makeRec({ id: 'h-1', status: 'resolved', title: 'Cached rec' })],
          },
        });
      },
    );

    await page.goto('/recommendations');
    await expect(page.getByText('No open recommendations across any project.')).toBeVisible({ timeout: 8_000 });

    // First visit triggers load
    await page.getByRole('tab', { name: /^History$/ }).click();
    await expect(page.getByText('Cached rec')).toBeVisible({ timeout: 6_000 });
    expect(historyCallCount).toBe(1);

    // Switch away and back — should NOT re-fetch
    await page.getByRole('tab', { name: /Unresolved/ }).click();
    await page.getByRole('tab', { name: /History/ }).click();
    await expect(page.getByText('Cached rec')).toBeVisible();
    expect(historyCallCount).toBe(1);
  });

  // ─── Empty history state ─────────────────────────────────────────────────────
  test('shows empty state when nothing resolved yet', async ({ page }) => {
    await stubShellRoutes(page);

    await page.route(
      (url) => url.pathname === '/api/recommendations' && !url.searchParams.has('state'),
      (route: Route) => route.fulfill({ json: { recommendations: [] } }),
    );
    await page.route(
      (url) => url.pathname === '/api/recommendations' && url.searchParams.get('state') === 'history',
      (route: Route) => route.fulfill({ json: { recommendations: [] } }),
    );

    await page.goto('/recommendations');
    await expect(page.getByText('No open recommendations across any project.')).toBeVisible({ timeout: 8_000 });

    await page.getByRole('tab', { name: /^History$/ }).click();

    await expect(
      page.getByText(
        'Nothing resolved yet — auto-resolved, dismissed, and applied recommendations will appear here.',
      ),
    ).toBeVisible({ timeout: 6_000 });
  });

  // ─── History load error + retry ──────────────────────────────────────────────
  test('shows error with Retry button when history fails to load and clears on retry', async ({ page }) => {
    await stubShellRoutes(page);

    await page.route(
      (url) => url.pathname === '/api/recommendations' && !url.searchParams.has('state'),
      (route: Route) => route.fulfill({ json: { recommendations: [] } }),
    );

    let callCount = 0;
    await page.route(
      (url) => url.pathname === '/api/recommendations' && url.searchParams.get('state') === 'history',
      (route: Route) => {
        callCount++;
        if (callCount === 1) {
          route.fulfill({ status: 500, body: '{"detail":"db error"}' });
        } else {
          route.fulfill({ json: { recommendations: [] } });
        }
      },
    );

    await page.goto('/recommendations');
    await expect(page.getByText('No open recommendations across any project.')).toBeVisible({ timeout: 8_000 });

    await page.getByRole('tab', { name: /^History$/ }).click();

    await expect(page.getByText('Failed to load history.')).toBeVisible({ timeout: 6_000 });
    const retryBtn = page.getByRole('button', { name: 'Retry' });
    await expect(retryBtn).toBeVisible();

    await retryBtn.click();

    // Successful retry shows empty history state, error disappears
    await expect(
      page.getByText(
        'Nothing resolved yet — auto-resolved, dismissed, and applied recommendations will appear here.',
      ),
    ).toBeVisible({ timeout: 6_000 });
    await expect(page.getByText('Failed to load history.')).not.toBeVisible();
  });

  // ─── History reloads when tab is visible during a dismiss ────────────────────
  test('reloads history immediately when dismiss fires while History tab is active', async ({ page }) => {
    await stubShellRoutes(page);

    const openRec = makeRec({ id: 'rec-open', title: 'Open rec', type: 'other_type', agent_id: null });

    let openCallCount = 0;
    await page.route(
      (url) => url.pathname === '/api/recommendations' && !url.searchParams.has('state'),
      (route: Route) => {
        openCallCount++;
        // Second+ call (after dismiss) returns empty
        route.fulfill({ json: { recommendations: openCallCount <= 1 ? [openRec] : [] } });
      },
    );

    let historyCallCount = 0;
    await page.route(
      (url) => url.pathname === '/api/recommendations' && url.searchParams.get('state') === 'history',
      (route: Route) => {
        historyCallCount++;
        const items =
          historyCallCount >= 2
            ? [makeRec({ id: 'h-dismissed', status: 'dismissed', title: 'Just dismissed rec' })]
            : [];
        route.fulfill({ json: { recommendations: items } });
      },
    );

    // Intercept dismiss PATCH for by-project route
    await page.route(
      (url) =>
        url.pathname.includes('/by-project/my-project/recommendations') &&
        !url.pathname.includes('/apply'),
      (route: Route) => {
        if (route.request().method() === 'PATCH') {
          route.fulfill({ json: { recommendation: { ...openRec, status: 'dismissed' } } });
        } else {
          route.continue();
        }
      },
    );

    await page.goto('/recommendations');
    await expect(page.getByText('Open rec')).toBeVisible({ timeout: 8_000 });

    // Open History tab first so it loads (empty at this point)
    await page.getByRole('tab', { name: /^History$/ }).click();
    await expect(
      page.getByText(
        'Nothing resolved yet — auto-resolved, dismissed, and applied recommendations will appear here.',
      ),
    ).toBeVisible({ timeout: 6_000 });
    expect(historyCallCount).toBe(1);

    // Go back to Unresolved and dismiss
    await page.getByRole('tab', { name: /Unresolved/ }).click();
    await page
      .getByRole('button', { name: /Dismiss recommendation.*Open rec/i })
      .click();

    // Switch to History tab — history should have been invalidated and reloads on open
    await page.getByRole('tab', { name: /History/ }).click();

    await expect(page.getByText('Just dismissed rec')).toBeVisible({ timeout: 6_000 });
  });
});
