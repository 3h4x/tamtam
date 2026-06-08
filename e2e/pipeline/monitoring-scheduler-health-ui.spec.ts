import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const BASE_TIME = Date.parse('2026-05-28T10:00:00.000Z');

const MONITORING_DATA = {
  prometheus: { status: 'ok', alerts: [], services: [] },
  loki: { status: 'ok', errors: [], warnings: [] },
  notificationThrottle: {
    windowSeconds: 300,
    overrides: {},
    suppressedTotal: 0,
    entries: [],
  },
  retention: {
    policy: {
      logRetentionCount: 200,
      logRetentionDays: 30,
      jobRowRetentionDays: 180,
    },
    lastProjectLogCleanup: null,
    lastNightlyCleanup: null,
  },
  hasIssues: false,
  fetchedAt: BASE_TIME,
  windowMs: 15 * 60 * 1000,
  config: { prometheusUrl: '', lokiUrl: '' },
};

const PM2_LOGS = {
  status: 'ok',
  entries: [],
  path: '/tmp/tamtam.log',
  fetchedAt: BASE_TIME,
};

function schedulerEntry(overrides: Partial<{
  agentId: string;
  project: string;
  name: string;
  schedule: string;
  enabled: boolean;
  nextFireMs: number;
  lastFireMs: number | null;
  lastJobMs: number | null;
  fireCount: number;
  errorCount: number;
  lastError: string | null;
}> = {}) {
  return {
    agentId: 'agent-monitoring',
    project: 'monitoring-project',
    name: 'health-check',
    schedule: '*/5 * * * *',
    enabled: true,
    nextFireMs: BASE_TIME + 5 * 60 * 1000,
    lastFireMs: BASE_TIME - 5 * 60 * 1000,
    lastJobMs: BASE_TIME - 4 * 60 * 1000,
    fireCount: 1,
    errorCount: 0,
    lastError: null,
    ...overrides,
  };
}

function schedulerHealth(ok: boolean, entry = schedulerEntry()) {
  return {
    ok,
    expected: [
      {
        id: 'agent-monitoring',
        project: 'monitoring-project',
        name: 'health-check',
        schedule: '*/5 * * * *',
        expectedName: 'agent:monitoring-project:health-check',
        queueKey: 'agent:monitoring-project:health-check',
        promptFileLoaded: true,
        queueLoaded: ok,
      },
    ],
    actual: { graphile: ok ? ['agent:monitoring-project:health-check'] : [] },
    missing: ok
      ? []
      : [
          {
            id: 'agent-monitoring',
            project: 'monitoring-project',
            name: 'health-check',
            schedule: '*/5 * * * *',
            expectedName: 'agent:monitoring-project:health-check',
            queueKey: 'agent:monitoring-project:health-check',
            promptFileLoaded: true,
            queueLoaded: false,
          },
        ],
    orphans: { graphile: [] },
    errors: ok ? [] : ['queue job is missing for monitoring-project/health-check'],
    internal: { started: true, entries: [entry] },
  };
}

async function stubMonitoringShell(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/monitoring',
    (route: Route) => route.fulfill({ json: MONITORING_DATA }),
  );
  await page.route(
    (url) => url.pathname === '/api/monitoring/pm2-logs',
    (route: Route) => route.fulfill({ json: PM2_LOGS }),
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
}

test.describe('Monitoring scheduler health UI', () => {
  test('overview load failure shows Retry and recovers in place when monitoring responds again', async ({
    page,
  }) => {
    let monitoringHealthy = false;

    await page.route(
      (url) => url.pathname === '/api/monitoring',
      (route: Route) => {
        if (!monitoringHealthy) {
          return route.fulfill({
            status: 500,
            json: { detail: 'metrics backend unavailable' },
          });
        }
        return route.fulfill({ json: MONITORING_DATA });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/monitoring/pm2-logs',
      (route: Route) => route.fulfill({ json: PM2_LOGS }),
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

    await page.goto('/monitoring');

    await expect(page.getByText('Failed to fetch monitoring data')).toBeVisible({
      timeout: 8_000,
    });
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();

    const stableUrl = page.url();
    monitoringHealthy = true;
    await retry.click();

    await expect(page.getByText('All systems OK')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Readiness checks')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Failed to fetch monitoring data')).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });

  test('Agents tab refreshes scheduler health entries on the 30s poll without reload', async ({
    page,
  }) => {
    await page.clock.install({ time: BASE_TIME });
    await stubMonitoringShell(page);

    let schedulerHealthy = true;
    await page.route('**/api/agents/scheduler-health', (route: Route) => {
      return route.fulfill({
        json: schedulerHealth(
          schedulerHealthy,
          schedulerEntry({
            fireCount: schedulerHealthy ? 1 : 2,
            errorCount: schedulerHealthy ? 0 : 1,
            lastError: schedulerHealthy ? null : 'queue job is missing',
          }),
        ),
      });
    });

    await page.goto('/monitoring');
    await page.getByRole('button', { name: 'Agents' }).click();

    await expect(page.getByText('All scheduled agents have prompt files and Graphile queue jobs ready.')).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('monitoring-project/health-check')).toBeVisible();
    await expect(page.getByText('1/1!')).toHaveCount(0);

    schedulerHealthy = false;
    await page.clock.fastForward(30_000);

    await expect(page.getByText('queue job is missing for monitoring-project/health-check')).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText('2/1!')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconcile' })).toBeEnabled();
  });
});
