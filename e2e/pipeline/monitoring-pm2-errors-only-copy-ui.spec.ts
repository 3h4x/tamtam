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

const FILES: Pm2File[] = [
  { path: '/home/u/.pm2/logs/tamtam-error.log', size: 2 * 1024 * 1024, mtime: new Date(BASE_TIME).toISOString() },
];

// Distinct markers so we can assert which source survives the toggle.
const STDERR_ERR = 'Database pool exhausted STDERRERR';
const STDOUT_WARN = 'Cron run skipped STDOUTWARN';
const STDOUT_INFO = 'Health check ok STDOUTINFO';

const ENTRIES: Pm2Entry[] = [
  { ts: new Date(BASE_TIME).toISOString(), level: 'error', line: STDERR_ERR, source: 'error' },
  { ts: new Date(BASE_TIME - 1000).toISOString(), level: 'warn', line: STDOUT_WARN, source: 'out' },
  { ts: new Date(BASE_TIME - 2000).toISOString(), level: 'info', line: STDOUT_INFO, source: 'out' },
];

async function openLogsTab(page: Page) {
  await page.goto('/monitoring');
  await page.getByRole('button', { name: 'Logs' }).click();
  await expect(page.getByText('tamtam (PM2)')).toBeVisible({ timeout: 8_000 });
}

test.describe('Monitoring PM2 "errors only" toggle drops stdout from rows and Copy all', () => {
  test('toggling errors only hides stdout rows and the Copy-all export reflects it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stubMonitoring(page, pm2Logs(FILES, ENTRIES));
    await openLogsTab(page);

    // Default: warn+ level filter, all sources. Shows the stderr error + stdout warn.
    const errRow = page.locator('div.group', { hasText: STDERR_ERR });
    const warnRow = page.locator('div.group', { hasText: STDOUT_WARN });
    await expect(errRow).toBeVisible();
    await expect(warnRow).toBeVisible();

    // Copy all under "all sources" includes the stdout warn line.
    await page.getByRole('button', { name: 'Copy all' }).click();
    const before = await page.evaluate(() => navigator.clipboard.readText());
    expect(before).toContain('[ERROR]');
    expect(before).toContain('[WARN]');
    expect(before).toContain(STDOUT_WARN);
    expect(before.split('\n')).toHaveLength(2);

    // Toggle to "errors only": stdout-sourced rows drop, leaving only the stderr error.
    await page.getByRole('button', { name: 'all sources' }).click();
    await expect(page.getByRole('button', { name: 'errors only' })).toBeVisible();
    await expect(errRow).toBeVisible();
    await expect(warnRow).toHaveCount(0);

    // Copy all now excludes the stdout warn entirely — export mirrors the source filter.
    await page.getByRole('button', { name: 'Copy all' }).click();
    const after = await page.evaluate(() => navigator.clipboard.readText());
    expect(after).toContain('[ERROR]');
    expect(after).toContain(STDERR_ERR);
    expect(after).not.toContain('[WARN]');
    expect(after).not.toContain(STDOUT_WARN);
    expect(after.split('\n')).toHaveLength(1);
  });

  test('errors only + All level filter still excludes stdout info entries', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stubMonitoring(page, pm2Logs(FILES, ENTRIES));
    await openLogsTab(page);

    // Switch to the All level filter so info would normally show.
    await page.getByRole('button', { name: /^All\b/ }).click();
    await expect(page.locator('div.group', { hasText: STDOUT_INFO })).toBeVisible();

    // Errors only removes both stdout warn and stdout info, leaving just the stderr error.
    await page.getByRole('button', { name: 'all sources' }).click();
    await expect(page.locator('div.group', { hasText: STDERR_ERR })).toBeVisible();
    await expect(page.locator('div.group', { hasText: STDOUT_INFO })).toHaveCount(0);
    await expect(page.locator('div.group', { hasText: STDOUT_WARN })).toHaveCount(0);

    await page.getByRole('button', { name: 'Copy all' }).click();
    const after = await page.evaluate(() => navigator.clipboard.readText());
    expect(after).not.toContain(STDOUT_INFO);
    expect(after).not.toContain(STDOUT_WARN);
    expect(after.split('\n')).toHaveLength(1);
  });
});
