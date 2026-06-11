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

test.describe('Monitoring PM2 mixed-files header (some sources missing)', () => {
  test('one available file + one errored file renders size, missing-source warning, and a filtered count', async ({ page }) => {
    // availableFiles = [OUT] (non-empty -> NOT the missingAllFiles branch), fileErrors = [ERR].
    // This is the mixed-state header: per-file size/mtime for the available file plus
    // an "N missing source(s)" warning for the errored one.
    const files: Pm2File[] = [
      { path: OUT_PATH, size: 2 * 1024 * 1024, mtime: new Date(BASE_TIME).toISOString() },
      { path: ERR_PATH, size: null, mtime: null, error: 'ENOENT: no such file' },
    ];
    // 1 info + 1 warn. Default filter is warn+ -> only the warn entry shows,
    // so filtered (1) !== allEntries (2) and the "showing X of Y" line appears.
    const entries: Pm2Entry[] = [
      { ts: new Date(BASE_TIME).toISOString(), level: 'info', line: 'Health check ok INFOLINE', source: 'out' },
      { ts: new Date(BASE_TIME).toISOString(), level: 'warn', line: 'Disk getting full WARNLINE', source: 'out' },
    ];
    await stubMonitoring(page, pm2Logs(files, entries));
    await openLogsTab(page);

    // The available file is summarized with its basename and human-readable size.
    await expect(page.getByText('tamtam-out.log')).toBeVisible();
    await expect(page.getByText('· 2.0 MB')).toBeVisible();

    // The single errored file surfaces as a missing-source warning (singular).
    await expect(page.getByText('1 missing source')).toBeVisible();
    // It must NOT regress into the "all files missing" notice.
    await expect(page.getByText('PM2 log files were not found on this host.')).toHaveCount(0);

    // warn+ default hides the info row -> partial-view count line is shown.
    await expect(page.getByText('showing 1 of 2')).toBeVisible();
    await expect(page.locator('div.group', { hasText: 'WARNLINE' })).toBeVisible();
    await expect(page.locator('div.group', { hasText: 'INFOLINE' })).toHaveCount(0);

    // Switching to All matches every entry -> the partial-view count line disappears.
    await page.getByRole('button', { name: /^All\b/ }).click();
    await expect(page.getByText('showing 1 of 2')).toHaveCount(0);
    await expect(page.locator('div.group', { hasText: 'INFOLINE' })).toBeVisible();
  });
});
