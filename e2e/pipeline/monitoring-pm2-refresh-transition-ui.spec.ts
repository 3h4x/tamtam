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

async function stubMonitoring(page: Page, getPm2Logs: () => ReturnType<typeof pm2Logs>): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/monitoring',
    (route: Route) => route.fulfill({ json: monitoringData() }),
  );
  await page.route(
    (url) => url.pathname === '/api/monitoring/pm2-logs',
    (route: Route) => route.fulfill({ json: getPm2Logs() }),
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
  { path: '/home/u/.pm2/logs/tamtam-error.log', size: 1024 * 1024, mtime: new Date(BASE_TIME).toISOString() },
];

const ERROR_LINE = 'Worker crashed while reconciling jobs ERROR_REFRESH_MARKER';
const INFO_LINE = 'Scheduler heartbeat clean INFO_REFRESH_MARKER';

test.describe('Monitoring PM2 refresh transition', () => {
  test('manual PM2 refresh clears the error badge and swaps the log list without a page reload', async ({ page }) => {
    let phase: 'error' | 'clean' = 'error';
    await stubMonitoring(page, () => (
      phase === 'error'
        ? pm2Logs(FILES, [
            { ts: new Date(BASE_TIME).toISOString(), level: 'error', line: ERROR_LINE, source: 'error' },
          ])
        : pm2Logs(FILES, [
            { ts: new Date(BASE_TIME).toISOString(), level: 'info', line: INFO_LINE, source: 'out' },
          ])
    ));

    await page.goto('/monitoring');
    const logsTab = page.getByRole('button', { name: /Logs/ });
    await expect(logsTab).toHaveText(/Logs\s*1/, { timeout: 8_000 });
    await logsTab.click();

    await expect(page.getByText('tamtam (PM2)')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/\u25cf issues/)).toBeVisible();
    await expect(page.locator('div.group', { hasText: ERROR_LINE })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy all' })).toBeVisible();

    phase = 'clean';
    await page.getByRole('button', { name: 'Refresh' }).last().click();

    await expect(logsTab).toHaveText(/^Logs$/, { timeout: 8_000 });
    await expect(page.getByText(/\u25cf ok/)).toBeVisible();
    await expect(page.locator('div.group', { hasText: ERROR_LINE })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy all' })).toHaveCount(0);
    await expect(page.getByText('No warnings or errors in the current source selection.')).toBeVisible();

    await page.getByRole('button', { name: /^All\b/ }).click();
    await expect(page.locator('div.group', { hasText: INFO_LINE })).toBeVisible();
  });
});
