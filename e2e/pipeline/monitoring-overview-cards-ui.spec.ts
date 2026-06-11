import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const BASE_TIME = Date.parse('2026-05-28T10:00:00.000Z');
const BASE_SECONDS = Math.floor(BASE_TIME / 1000);

type PromResult = { metric: Record<string, string>; value: [number, string] };
type LogLine = { ts: string; stream: Record<string, string>; line: string };
type ThrottleEntry = { key: string; lastSentAt: number; suppressedCount: number };

function monitoringData(overrides: {
  prometheus?: Partial<{ status: 'ok' | 'unavailable'; alerts: PromResult[]; services: PromResult[] }>;
  loki?: Partial<{ status: 'ok' | 'unavailable'; errors: LogLine[]; warnings: LogLine[] }>;
  notificationThrottle?: Partial<{ windowSeconds: number; suppressedTotal: number; entries: ThrottleEntry[] }>;
  retention?: {
    lastNightlyCleanup?: Record<string, unknown> | null;
    lastProjectLogCleanup?: Record<string, unknown> | null;
  };
  hasIssues?: boolean;
} = {}) {
  return {
    prometheus: { status: 'ok' as const, alerts: [], services: [], ...overrides.prometheus },
    loki: { status: 'ok' as const, errors: [], warnings: [], ...overrides.loki },
    notificationThrottle: {
      windowSeconds: 300,
      overrides: {},
      suppressedTotal: 0,
      entries: [],
      ...overrides.notificationThrottle,
    },
    retention: {
      policy: { logRetentionCount: 200, logRetentionDays: 30, jobRowRetentionDays: 180 },
      lastProjectLogCleanup: overrides.retention?.lastProjectLogCleanup ?? null,
      lastNightlyCleanup: overrides.retention?.lastNightlyCleanup ?? null,
    },
    hasIssues: overrides.hasIssues ?? false,
    fetchedAt: BASE_TIME,
    windowMs: 15 * 60 * 1000,
    config: { prometheusUrl: 'http://localhost:9090', lokiUrl: 'http://localhost:3100' },
  };
}

async function stubMonitoring(page: Page, monitoring: ReturnType<typeof monitoringData>): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/monitoring',
    (route: Route) => route.fulfill({ json: monitoring }),
  );
  await page.route(
    (url) => url.pathname === '/api/monitoring/pm2-logs',
    (route: Route) => route.fulfill({ json: { files: [], entries: [], fetchedAt: BASE_TIME } }),
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
}

test.describe('Monitoring Overview cards UI', () => {
  test('suppressed notifications render the pending count and the throttle entries panel', async ({ page }) => {
    const data = monitoringData({
      notificationThrottle: {
        suppressedTotal: 3,
        entries: [{ key: 'release_fail:demo-project', lastSentAt: BASE_TIME, suppressedCount: 3 }],
      },
    });
    await stubMonitoring(page, data);

    await page.goto('/monitoring');

    // Notifications summary card surfaces the pending suppressed count.
    await expect(page.getByText('3 suppressed alerts pending')).toBeVisible({ timeout: 8_000 });
    // Throttle entries panel lists the throttled key.
    await expect(page.getByRole('heading', { name: 'Notification throttle' })).toBeVisible();
    await expect(page.getByText('release_fail:demo-project')).toBeVisible();
  });

  test('a failed nightly retention cleanup marks the Retention card as an issue with the error line', async ({ page }) => {
    const data = monitoringData({
      retention: {
        lastNightlyCleanup: {
          type: 'nightly',
          status: 'failed',
          startedAt: BASE_SECONDS,
          finishedAt: BASE_SECONDS,
          rowsScanned: 10,
          rowsDeleted: 5,
          skippedRunningRows: 0,
          errorCount: 1,
          lastError: 'disk full',
        },
        lastProjectLogCleanup: {
          type: 'project_logs',
          project: 'demo-project',
          status: 'failed',
          startedAt: BASE_SECONDS,
          finishedAt: BASE_SECONDS,
          rowsScanned: 4,
          rowsEligible: 2,
          rowsUpdated: 2,
          logFilesDeleted: 2,
          bytesReclaimed: 1024,
          skippedRunningRows: 0,
          errorCount: 1,
          lastError: 'permission denied',
        },
      },
      hasIssues: true,
    });
    await stubMonitoring(page, data);

    await page.goto('/monitoring');

    // Formatted nightly + project-log cleanup lines surface the failed status and error.
    await expect(page.getByText('failed · 5 rows · disk full')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('failed · 2 files, 1.0 KB · permission denied')).toBeVisible();
  });

  test('firing alerts and down services render inline panels on the Overview tab', async ({ page }) => {
    const data = monitoringData({
      prometheus: {
        status: 'ok',
        alerts: [
          { metric: { alertname: 'HighErrorRate', severity: 'critical', instance: 'host:9090' }, value: [BASE_SECONDS, '1'] },
        ],
        services: [
          { metric: { job: 'node_exporter', instance: 'host:9100' }, value: [BASE_SECONDS, '0'] },
        ],
      },
      hasIssues: true,
    });
    await stubMonitoring(page, data);

    await page.goto('/monitoring');

    // Firing alerts inline panel.
    await expect(page.getByRole('heading', { name: 'Firing alerts' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('HighErrorRate')).toBeVisible();
    await expect(page.getByText('critical')).toBeVisible();
    // Down services inline panel.
    await expect(page.getByRole('heading', { name: 'Down services' })).toBeVisible();
    await expect(page.getByText('node_exporter')).toBeVisible();
  });
});
