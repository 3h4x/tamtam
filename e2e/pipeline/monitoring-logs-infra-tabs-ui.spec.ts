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

type LogLine = { ts: string; stream: Record<string, string>; line: string };

function monitoringData(overrides: {
  prometheus?: Partial<{
    status: 'ok' | 'unavailable';
    alerts: Array<{ metric: Record<string, string>; value: [number, string] }>;
    services: Array<{ metric: Record<string, string>; value: [number, string] }>;
  }>;
  loki?: Partial<{ status: 'ok' | 'unavailable'; errors: LogLine[]; warnings: LogLine[] }>;
  hasIssues?: boolean;
  config?: { prometheusUrl: string; lokiUrl: string };
} = {}) {
  return {
    prometheus: {
      status: 'ok' as const,
      alerts: [],
      services: [],
      ...overrides.prometheus,
    },
    loki: {
      status: 'ok' as const,
      errors: [],
      warnings: [],
      ...overrides.loki,
    },
    notificationThrottle: { windowSeconds: 300, overrides: {}, suppressedTotal: 0, entries: [] },
    retention: {
      policy: { logRetentionCount: 200, logRetentionDays: 30, jobRowRetentionDays: 180 },
      lastProjectLogCleanup: null,
      lastNightlyCleanup: null,
    },
    hasIssues: overrides.hasIssues ?? false,
    fetchedAt: BASE_TIME,
    windowMs: 15 * 60 * 1000,
    config: overrides.config ?? { prometheusUrl: 'http://localhost:9090', lokiUrl: 'http://localhost:3100' },
  };
}

async function stubMonitoring(
  page: Page,
  opts: { monitoring: ReturnType<typeof monitoringData>; pm2: ReturnType<typeof pm2Logs> },
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/monitoring',
    (route: Route) => route.fulfill({ json: opts.monitoring }),
  );
  await page.route(
    (url) => url.pathname === '/api/monitoring/pm2-logs',
    (route: Route) => route.fulfill({ json: opts.pm2 }),
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
      json: { ok: true, expected: [], actual: { graphile: [] }, missing: [], orphans: { graphile: [] }, errors: [], internal: { started: true, entries: [] } },
    }),
  );
}

const FILES: Pm2File[] = [
  { path: '/home/u/.pm2/logs/tamtam-error.log', size: 2 * 1024 * 1024, mtime: new Date(BASE_TIME).toISOString() },
  { path: '/home/u/.pm2/logs/tamtam-out.log', size: 5 * 1024 * 1024, mtime: new Date(BASE_TIME).toISOString() },
];

const MIXED_ENTRIES: Pm2Entry[] = [
  { ts: new Date(BASE_TIME).toISOString(), level: 'error', line: 'Database connection refused on startup', source: 'error' },
  { ts: new Date(BASE_TIME - 1000).toISOString(), level: 'warn', line: 'Retry scheduled for queued job', source: 'out' },
  { ts: new Date(BASE_TIME - 2000).toISOString(), level: 'info', line: 'Scheduler tick completed cleanly', source: 'out' },
];

test.describe('Monitoring Logs tab UI', () => {
  test('warn+ default hides info, level filters and source toggle repartition rows without reload', async ({ page }) => {
    await stubMonitoring(page, { monitoring: monitoringData(), pm2: pm2Logs(FILES, MIXED_ENTRIES) });

    await page.goto('/monitoring');
    await page.getByRole('button', { name: 'Logs' }).click();

    await expect(page.getByText('tamtam (PM2)')).toBeVisible({ timeout: 8_000 });

    // warn+ default: error + warn visible, info hidden, "showing 2 of 3" indicator.
    await expect(page.getByText('Database connection refused on startup')).toBeVisible();
    await expect(page.getByText('Retry scheduled for queued job')).toBeVisible();
    await expect(page.getByText('Scheduler tick completed cleanly')).toHaveCount(0);
    await expect(page.getByText('showing 2 of 3')).toBeVisible();

    // Switch to Info: only the info line shows.
    await page.getByRole('button', { name: /Info/ }).click();
    await expect(page.getByText('Scheduler tick completed cleanly')).toBeVisible();
    await expect(page.getByText('Database connection refused on startup')).toHaveCount(0);

    // Switch to All: every line shows, no "showing N of M" indicator (filtered === all).
    await page.getByRole('button', { name: /All/ }).click();
    await expect(page.getByText('Database connection refused on startup')).toBeVisible();
    await expect(page.getByText('Retry scheduled for queued job')).toBeVisible();
    await expect(page.getByText('Scheduler tick completed cleanly')).toBeVisible();
    await expect(page.getByText(/showing \d+ of \d+/)).toHaveCount(0);

    // "all sources" → "errors only": only stderr-sourced rows survive.
    await page.getByRole('button', { name: 'all sources' }).click();
    await expect(page.getByText('Database connection refused on startup')).toBeVisible();
    await expect(page.getByText('Retry scheduled for queued job')).toHaveCount(0);
    await expect(page.getByText('Scheduler tick completed cleanly')).toHaveCount(0);
  });

  test('errors-only + warn filter with no matching source shows the scoped empty state', async ({ page }) => {
    await stubMonitoring(page, { monitoring: monitoringData(), pm2: pm2Logs(FILES, MIXED_ENTRIES) });

    await page.goto('/monitoring');
    await page.getByRole('button', { name: 'Logs' }).click();
    await expect(page.getByText('tamtam (PM2)')).toBeVisible({ timeout: 8_000 });

    await page.getByRole('button', { name: 'all sources' }).click(); // → errors only
    await page.getByRole('button', { name: /Warn(?!\+)/ }).click(); // plain "Warn", not "warn+"

    await expect(
      page.getByText('No warn entries in the current source selection.'),
    ).toBeVisible();
  });

  test('all log files missing renders the not-found panel with the failing paths', async ({ page }) => {
    const missing = pm2Logs(
      [
        { path: '/home/u/.pm2/logs/tamtam-error.log', size: null, mtime: null, error: 'ENOENT' },
        { path: '/home/u/.pm2/logs/tamtam-out.log', size: null, mtime: null, error: 'ENOENT' },
      ],
      [],
    );
    await stubMonitoring(page, { monitoring: monitoringData(), pm2: missing });

    await page.goto('/monitoring');
    await page.getByRole('button', { name: 'Logs' }).click();

    await expect(page.getByText('PM2 log files were not found on this host.')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('/home/u/.pm2/logs/tamtam-error.log')).toBeVisible();
  });
});

test.describe('Monitoring Infra tab UI', () => {
  test('prometheus down + up services render summary counts and per-target status', async ({ page }) => {
    const data = monitoringData({
      prometheus: {
        status: 'ok',
        services: [
          { metric: { job: 'netrunner', instance: 'host:3333' }, value: [BASE_TIME / 1000, '1'] },
          { metric: { job: 'node_exporter', instance: 'host:9100' }, value: [BASE_TIME / 1000, '0'] },
        ],
      },
      hasIssues: true,
    });
    await stubMonitoring(page, { monitoring: data, pm2: pm2Logs(FILES, []) });

    await page.goto('/monitoring');
    await page.getByRole('button', { name: 'Infra' }).click();

    await expect(page.getByText('Prometheus')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('services down')).toBeVisible();
    await expect(page.getByText('services up')).toBeVisible();
    // Both target jobs render under Service status.
    await expect(page.getByText('netrunner')).toBeVisible();
    await expect(page.getByText('node_exporter')).toBeVisible();
  });

  test('unavailable Prometheus and Loki backends render the not-reachable panels with endpoints', async ({ page }) => {
    const data = monitoringData({
      prometheus: { status: 'unavailable' },
      loki: { status: 'unavailable' },
      config: { prometheusUrl: 'http://prom.example:9090', lokiUrl: 'http://loki.example:3100' },
      hasIssues: true,
    });
    await stubMonitoring(page, { monitoring: data, pm2: pm2Logs(FILES, []) });

    await page.goto('/monitoring');
    await page.getByRole('button', { name: 'Infra' }).click();

    await expect(page.getByText('http://prom.example:9090')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('http://loki.example:3100')).toBeVisible();
  });

  test('Loki error lines render in the error log section with the error count card', async ({ page }) => {
    const data = monitoringData({
      loki: {
        status: 'ok',
        errors: [
          { ts: String(BASE_TIME * 1_000_000), stream: { job: 'netrunner' }, line: 'fatal: scheduler crashed unexpectedly' },
        ],
      },
      hasIssues: true,
    });
    await stubMonitoring(page, { monitoring: data, pm2: pm2Logs(FILES, []) });

    await page.goto('/monitoring');
    await page.getByRole('button', { name: 'Infra' }).click();

    await expect(page.getByText('Error log lines')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('fatal: scheduler crashed unexpectedly')).toBeVisible();
    await expect(page.getByText('[netrunner]')).toBeVisible();
  });
});
