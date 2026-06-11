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

// 180-char line so slice(0,160) hides the tail marker until expanded.
const LONG_HEAD = 'HEADMARKER';
const LONG_TAIL = 'TAILMARKER';
const LONG_LINE = LONG_HEAD + '-'.repeat(160) + LONG_TAIL;

const SHORT_LINE = 'Retry scheduled for queued job';

const ENTRIES: Pm2Entry[] = [
  { ts: new Date(BASE_TIME).toISOString(), level: 'error', line: LONG_LINE, source: 'error' },
  { ts: new Date(BASE_TIME - 1000).toISOString(), level: 'warn', line: SHORT_LINE, source: 'out' },
];

async function openLogsTab(page: Page) {
  await page.goto('/monitoring');
  await page.getByRole('button', { name: 'Logs' }).click();
  await expect(page.getByText('tamtam (PM2)')).toBeVisible({ timeout: 8_000 });
}

test.describe('Monitoring PM2 log row expand/collapse + copy UI', () => {
  test('long line truncates with expand affordance, then expands and collapses in place', async ({ page }) => {
    await stubMonitoring(page, pm2Logs(FILES, ENTRIES));
    await openLogsTab(page);

    // Collapsed: head visible, tail hidden, an "expand" affordance present.
    await expect(page.getByText(LONG_HEAD, { exact: false })).toBeVisible();
    await expect(page.getByText(LONG_TAIL, { exact: false })).toHaveCount(0);
    const expand = page.getByText('expand', { exact: true });
    await expect(expand).toBeVisible();

    // Click the row to expand → full line (tail) visible, a collapse button appears.
    await expand.click();
    await expect(page.getByText(LONG_TAIL, { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'collapse' })).toBeVisible();
    await expect(page.getByText('expand', { exact: true })).toHaveCount(0);

    // Collapse again → tail hidden, expand affordance back.
    await page.getByRole('button', { name: 'collapse' }).click();
    await expect(page.getByText(LONG_TAIL, { exact: false })).toHaveCount(0);
    await expect(page.getByText('expand', { exact: true })).toBeVisible();
  });

  test('per-row Copy writes the formatted line and Copy all writes every filtered entry', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stubMonitoring(page, pm2Logs(FILES, ENTRIES));
    await openLogsTab(page);

    // warn+ default shows both the error (long) and warn (short) rows.
    const shortRow = page.locator('div.group', { hasText: SHORT_LINE });
    await expect(shortRow).toBeVisible();

    // Per-row Copy button → "<ts> [LEVEL] <line>".
    await shortRow.getByRole('button', { name: 'Copy', exact: true }).click();
    const rowClip = await page.evaluate(() => navigator.clipboard.readText());
    expect(rowClip).toContain('[WARN]');
    expect(rowClip).toContain(SHORT_LINE);
    expect(rowClip).not.toContain('TAILMARKER');

    // Copy all → newline-joined export of both filtered rows (full long line included).
    await page.getByRole('button', { name: 'Copy all' }).click();
    const allClip = await page.evaluate(() => navigator.clipboard.readText());
    expect(allClip).toContain('[ERROR]');
    expect(allClip).toContain('[WARN]');
    expect(allClip).toContain(LONG_TAIL);
    expect(allClip.split('\n')).toHaveLength(2);
  });
});
