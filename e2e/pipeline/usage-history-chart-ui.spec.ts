import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// UsageHistoryChart UI tests — verify loading state, empty state, error state,
// provider tabs, and tab switching via mocked /api/stats/usage-history.
// All tests use port 1338; no real pipeline execution.

const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 };

const EMPTY_USAGE = {
  window: '30d',
  generatedAt: Date.now(),
  pricing: PRICE,
  totals: { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 0, costUsd: 0 },
  projects: [],
  agents: [],
};

const EMPTY_BRIDGE = {
  generatedAt: Date.now(),
  globalPace: { status: 'ok', marginsOk: true },
  throttle: null,
  projects: [],
  summary: { projects: 0, agentsEnabled: 0, releasing: 0, stuck: 0, attention: 0 },
};

async function stubPageRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/stats/usage*', (route: Route) => {
    if (route.request().url().includes('usage-history')) {
      // let the usage-history route be handled by the specific test stub
      return route.fallback();
    }
    return route.fulfill({ json: EMPTY_USAGE });
  });
  await page.route('**/api/stats/ollama*', (route: Route) =>
    route.fulfill({ json: { status: 'unavailable' } }),
  );
  await page.route('**/api/stats/bridge*', (route: Route) =>
    route.fulfill({ json: EMPTY_BRIDGE }),
  );
  await page.route('**/api/settings*', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
}

// Build a minimal ProviderSeries for test data.
function makeSeries(provider: string, opts: {
  totalTokens?: number | null;
  currentTokensPerHour?: number | null;
  expectedTokensPerHour?: number | null;
  catchUpTokensPerHour?: number | null;
} = {}) {
  const ts = Date.now() - 60 * 60 * 1000;
  const totalTokens = Object.hasOwn(opts, 'totalTokens') ? opts.totalTokens ?? null : 1000;
  return {
    provider,
    windowKey: '7d',
    buckets: [{ bucketTs: ts, provider, windowKey: '7d', totalTokens }],
    currentTokensPerHour: opts.currentTokensPerHour ?? 4000,
    expectedTokensPerHour: opts.expectedTokensPerHour ?? 3500,
    catchUpTokensPerHour: opts.catchUpTokensPerHour ?? 5000,
  };
}

test.describe('UsageHistoryChart', () => {
  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  test('shows "Loading usage history…" before data arrives', async ({ page }) => {
    let resolve: () => void;
    const blocker = new Promise<void>(r => { resolve = r; });

    await stubPageRoutes(page);
    await page.route('**/api/stats/usage-history*', async (route: Route) => {
      await blocker;
      await route.fulfill({ json: { generatedAt: Date.now(), hours: 48, series: [] } });
    });

    await page.goto('/stats');
    await expect(page.getByText('Loading usage history…')).toBeVisible({ timeout: 8_000 });
    resolve!();
  });

  // -------------------------------------------------------------------------
  // Empty state — no 7d series
  // -------------------------------------------------------------------------
  test('shows "No history yet" when series is empty', async ({ page }) => {
    await stubPageRoutes(page);
    await page.route('**/api/stats/usage-history*', (route: Route) =>
      route.fulfill({ json: { generatedAt: Date.now(), hours: 48, series: [] } }),
    );

    await page.goto('/stats');
    await expect(
      page.getByText(/No history yet/i),
    ).toBeVisible({ timeout: 8_000 });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  test('shows error message when usage-history API returns non-ok', async ({ page }) => {
    await stubPageRoutes(page);
    await page.route('**/api/stats/usage-history*', (route: Route) =>
      route.fulfill({ status: 500, body: 'Internal Server Error' }),
    );

    await page.goto('/stats');
    await expect(page.getByText(/usage-history:/i)).toBeVisible({ timeout: 8_000 });
  });

  // -------------------------------------------------------------------------
  // Single provider — "all providers" tab + provider tab both visible
  // -------------------------------------------------------------------------
  test('renders "all providers" and per-provider tabs when data is present', async ({ page }) => {
    await stubPageRoutes(page);
    await page.route('**/api/stats/usage-history*', (route: Route) =>
      route.fulfill({
        json: {
          generatedAt: Date.now(),
          hours: 48,
          series: [makeSeries('claude')],
        },
      }),
    );

    await page.goto('/stats');

    // Both tabs should be visible
    await expect(page.getByRole('button', { name: 'all providers' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'claude' })).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // Tab switching — clicking provider tab updates chart label
  // -------------------------------------------------------------------------
  test('clicking a provider tab switches the chart to that provider', async ({ page }) => {
    await stubPageRoutes(page);
    await page.route('**/api/stats/usage-history*', (route: Route) =>
      route.fulfill({
        json: {
          generatedAt: Date.now(),
          hours: 48,
          series: [makeSeries('claude'), makeSeries('gemini', { totalTokens: 2000 })],
        },
      }),
    );

    await page.goto('/stats');

    // Initial state: "all providers" tab is active (has border-status-info class)
    const allBtn = page.getByRole('button', { name: 'all providers' });
    await expect(allBtn).toBeVisible({ timeout: 8_000 });
    await expect(allBtn).toHaveClass(/border-status-info/);

    // Chart label should show aggregate label
    await expect(page.getByText('all providers · average')).toBeVisible({ timeout: 5_000 });

    // Click the "claude" tab
    await page.getByRole('button', { name: 'claude' }).click();

    // claude tab becomes active
    const claudeBtn = page.getByRole('button', { name: 'claude' });
    await expect(claudeBtn).toHaveClass(/border-status-info/);
    await expect(allBtn).not.toHaveClass(/border-status-info/);

    // Chart label updates to provider-specific label
    await expect(page.getByText('claude · 7d window')).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // Multiple providers — all tabs rendered
  // -------------------------------------------------------------------------
  test('renders a tab for each unique provider in the 7d window', async ({ page }) => {
    await stubPageRoutes(page);
    await page.route('**/api/stats/usage-history*', (route: Route) =>
      route.fulfill({
        json: {
          generatedAt: Date.now(),
          hours: 48,
          series: [
            makeSeries('claude'),
            makeSeries('gemini', { totalTokens: 500 }),
            makeSeries('codex', { totalTokens: 1500 }),
          ],
        },
      }),
    );

    await page.goto('/stats');

    await expect(page.getByRole('button', { name: 'all providers' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'claude' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'gemini' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'codex' })).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // Provider with no tokens — shows "No jobs routed" empty state
  // -------------------------------------------------------------------------
  test('shows "No jobs routed" empty state for a provider with only null token history', async ({
    page,
  }) => {
    await stubPageRoutes(page);
    await page.route('**/api/stats/usage-history*', (route: Route) =>
      route.fulfill({
        json: {
          generatedAt: Date.now(),
          hours: 48,
          series: [
            makeSeries('claude', {
              totalTokens: null,
              currentTokensPerHour: null,
              expectedTokensPerHour: null,
              catchUpTokensPerHour: null,
            }),
          ],
        },
      }),
    );

    await page.goto('/stats');

    // Select the claude tab so its ProviderChart is active
    await expect(page.getByRole('button', { name: 'claude' })).toBeVisible({ timeout: 8_000 });
    await page.getByRole('button', { name: 'claude' }).click();

    await expect(
      page.getByText(/No jobs routed to this provider/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});
