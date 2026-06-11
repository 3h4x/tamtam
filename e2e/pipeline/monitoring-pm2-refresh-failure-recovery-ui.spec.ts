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

async function stubMonitoring(
  page: Page,
  getPm2Phase: () => 'healthy' | 'failed',
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/monitoring',
    (route: Route) => route.fulfill({ json: monitoringData() }),
  );
  await page.route(
    (url) => url.pathname === '/api/monitoring/pm2-logs',
    (route: Route) => {
      if (getPm2Phase() === 'failed') {
        return route.fulfill({
          status: 503,
          json: { detail: 'pm2 log reader temporarily unavailable' },
        });
      }

      return route.fulfill({
        json: pm2Logs(FILES, [
          {
            ts: new Date(BASE_TIME).toISOString(),
            level: 'warn',
            line: PM2_LINE,
            source: 'out',
          },
        ]),
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/health',
    (route: Route) =>
      route.fulfill({
        json: {
          status: 'ok',
          ok: true,
          checks: [{ name: 'database', ok: true, severity: 'info', message: 'reachable' }],
        },
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
      json: {
        ok: true,
        expected: [],
        actual: { graphile: [] },
        missing: [],
        orphans: { graphile: [] },
        errors: [],
        internal: { started: true, entries: [] },
      },
    }),
  );
}

const FILES: Pm2File[] = [
  {
    path: '/home/u/.pm2/logs/tamtam-out.log',
    size: 2 * 1024 * 1024,
    mtime: new Date(BASE_TIME).toISOString(),
  },
];

const PM2_LINE = 'Scheduler heartbeat delayed PM2_FAILURE_RECOVERY_MARKER';

test.describe('Monitoring PM2 refresh failure recovery', () => {
  test('failed PM2 refresh keeps the last log rows visible, then clears the warning on recovery', async ({
    page,
  }) => {
    let phase: 'healthy' | 'failed' = 'healthy';
    await stubMonitoring(page, () => phase);

    await page.goto('/monitoring');
    await page.getByRole('button', { name: /Logs/ }).click();

    await expect(page.getByText('tamtam (PM2)')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('div.group', { hasText: PM2_LINE })).toBeVisible();
    await expect(page.getByText('PM2 log refresh failed. Showing last successful results.')).toHaveCount(0);

    phase = 'failed';
    await page.getByRole('button', { name: 'Refresh' }).last().click();

    await expect(page.getByText('PM2 log refresh failed. Showing last successful results.')).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('PM2 logs fetch failed (503)')).toBeVisible();
    await expect(page.locator('div.group', { hasText: PM2_LINE })).toBeVisible();
    await expect(page.getByText(/\u25cf ok/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy all' })).toBeVisible();

    phase = 'healthy';
    await page.getByRole('button', { name: 'Refresh' }).last().click();

    await expect(page.getByText('PM2 log refresh failed. Showing last successful results.')).toHaveCount(0, {
      timeout: 8_000,
    });
    await expect(page.locator('div.group', { hasText: PM2_LINE })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy all' })).toBeVisible();
  });
});
