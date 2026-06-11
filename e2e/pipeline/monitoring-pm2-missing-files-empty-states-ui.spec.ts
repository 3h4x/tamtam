import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const BASE_TIME = Date.parse('2026-05-28T10:00:00.000Z');

type Pm2Entry = {
  ts: string | null;
  level: 'error' | 'warn' | 'info';
  line: string;
  source: 'error' | 'out';
};

type Pm2File = { path: string; size: number | null; mtime: string | null; error?: string };

function pm2Logs(files: Pm2File[], entries: Pm2Entry[]) {
  return { files, entries, fetchedAt: BASE_TIME };
}

function monitoringData() {
  return {
    prometheus: { status: 'ok' as const, alerts: [], services: [] },
    loki: { status: 'ok' as const, errors: [], warnings: [] },
    notificationThrottle: { windowSeconds: 300, overrides: {}, suppressedTotal: 0, entries: [] },
    retention: {
      policy: { logRetentionCount: 200, logRetentionDays: 30, jobRowRetentionDays: 180 },
      lastProjectLogCleanup: null,
      lastNightlyCleanup: null,
    },
    hasIssues: false,
    fetchedAt: BASE_TIME,
    windowMs: 15 * 60 * 1000,
    config: { prometheusUrl: 'http://localhost:9090', lokiUrl: 'http://localhost:3100' },
  };
}

async function stubMonitoring(page: Page, pm2: ReturnType<typeof pm2Logs>): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/monitoring',
    (route: Route) => route.fulfill({ json: monitoringData() }),
  );
  await page.route(
    (url) => url.pathname === '/api/monitoring/pm2-logs',
    (route: Route) => route.fulfill({ json: pm2 }),
  );
  await page.route(
    (url) => url.pathname === '/api/health',
    (route: Route) =>
      route.fulfill({
        json: { status: 'ok', ok: true, checks: [{ name: 'database', ok: true, severity: 'info', message: 'reachable' }] },
      }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/agents/scheduler-health', (route: Route) =>
    route.fulfill({
      json: { ok: true, expected: [], actual: { graphile: [] }, missing: [], orphans: { graphile: [] }, errors: [], internal: { started: true, entries: [] } },
    }),
  );
}

async function openLogsTab(page: Page) {
  await page.goto('/monitoring');
  await page.getByRole('button', { name: 'Logs' }).click();
  await expect(page.getByText('tamtam (PM2)')).toBeVisible({ timeout: 8_000 });
}

const ERR_PATH = '/home/u/.pm2/logs/tamtam-error.log';
const OUT_PATH = '/home/u/.pm2/logs/tamtam-out.log';

test.describe('Monitoring PM2 missing-files and filtered-empty states', () => {
  test('all files erroring shows the "not found on this host" notice with each failed path, and no log rows', async ({ page }) => {
    // Every file carries an `error`, so availableFiles is empty -> missingAllFiles branch.
    // Entries are present but must NOT render because the missing-files branch short-circuits the list.
    const files: Pm2File[] = [
      { path: ERR_PATH, size: null, mtime: null, error: 'ENOENT: no such file' },
      { path: OUT_PATH, size: null, mtime: null, error: 'ENOENT: no such file' },
    ];
    const entries: Pm2Entry[] = [
      { ts: new Date(BASE_TIME).toISOString(), level: 'error', line: 'PHANTOM ENTRY should not render', source: 'error' },
    ];
    await stubMonitoring(page, pm2Logs(files, entries));
    await openLogsTab(page);

    await expect(page.getByText('PM2 log files were not found on this host.')).toBeVisible();
    // Each failed file path is listed so the operator knows which paths were probed.
    await expect(page.getByText(ERR_PATH)).toBeVisible();
    await expect(page.getByText(OUT_PATH)).toBeVisible();
    // The entries list is suppressed entirely under this branch.
    await expect(page.locator('div.group', { hasText: 'PHANTOM ENTRY' })).toHaveCount(0);
  });

  test('filtered-empty EmptyState message tracks the active level filter', async ({ page }) => {
    // One available file with only an info-level entry. Default filter is warn+ -> nothing matches.
    const files: Pm2File[] = [
      { path: ERR_PATH, size: 1024, mtime: new Date(BASE_TIME).toISOString() },
    ];
    const entries: Pm2Entry[] = [
      { ts: new Date(BASE_TIME).toISOString(), level: 'info', line: 'Health check ok INFOLINE', source: 'out' },
    ];
    await stubMonitoring(page, pm2Logs(files, entries));
    await openLogsTab(page);

    // warn+ default: an info-only feed yields the warn-or-error specific copy, not the generic one.
    await expect(page.getByText('No warnings or errors in the current source selection.')).toBeVisible();

    // A specific level filter swaps in the per-level phrasing.
    await page.getByRole('button', { name: /^Error\b/ }).click();
    await expect(page.getByText('No error entries in the current source selection.')).toBeVisible();

    await page.getByRole('button', { name: /^Warn\b/ }).click();
    await expect(page.getByText('No warn entries in the current source selection.')).toBeVisible();

    // Switching to All matches the info entry, so the empty state disappears and the row renders.
    await page.getByRole('button', { name: /^All\b/ }).click();
    await expect(page.locator('div.group', { hasText: 'INFOLINE' })).toBeVisible();
    await expect(page.getByText('in the current source selection.')).toHaveCount(0);
  });

  test('an available file with zero entries shows the "no recent PM2 log lines" message', async ({ page }) => {
    const files: Pm2File[] = [
      { path: ERR_PATH, size: 0, mtime: new Date(BASE_TIME).toISOString() },
    ];
    await stubMonitoring(page, pm2Logs(files, []));
    await openLogsTab(page);

    // allEntries.length === 0 -> the generic empty message regardless of the level filter.
    await expect(page.getByText('No recent PM2 log lines in the available files.')).toBeVisible();
  });
});
