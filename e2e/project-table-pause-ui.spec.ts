import { test, expect, type Page, type Route } from '@playwright/test';

const PROJECT = 'quota-fallback-ui';

function makeTask() {
  return {
    id: `${PROJECT}-task`,
    project: PROJECT,
    job: 'nightly',
    priority: 'medium',
    launchctl: 'running',
    path: `/tmp/${PROJECT}`,
    fires_at: '* * * * *',
    sync: true,
    changes: 0,
    unpushed: 0,
    reviewed: true,
    last_run: null,
    last_run_ago: null,
    last_run_duration_s: null,
    last_run_exit: null,
    release_tag: null,
    ci: 'success',
    ci_failed_url: null,
    github: null,
  };
}

async function mockProjectsTable(page: Page, schedulerThrottle: null | {
  reason: string;
  projectedPct: number;
  worstProvider: string;
  resumesAtMs: number | null;
}) {
  const nextFireMs = Date.now() + 10_000;

  await page.route('**/api/projects', (route: Route) => {
    route.fulfill({
      json: {
        tasks: [makeTask()],
        priorities: [],
        issueCounts: {},
      },
    });
  });

  await page.route('**/api/settings', (route: Route) => {
    route.fulfill({
      json: {
        settings: { jobs_paused: 'false' },
        github_owner: '',
      },
    });
  });

  await page.route('**/api/usage/quota', (route: Route) => {
    route.fulfill({
      json: {
        gateEnabled: true,
        sevenDay: {
          utilization: 90,
          resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          msUntilReset: 24 * 60 * 60 * 1000,
        },
        schedulerThrottle,
      },
    });
  });

  await page.route('**/api/agents/scheduler-health', (route: Route) => {
    route.fulfill({
      json: {
        internal: {
          paused: false,
          entries: [{
            agentId: 'agent-1',
            project: PROJECT,
            name: 'nightly',
            schedule: '1h',
            enabled: true,
            nextFireMs,
            lastFireMs: null,
          }],
        },
      },
    });
  });

  await page.route('**/api/jobs', (route: Route) => {
    route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } });
  });

  await page.route('**/api/agents', (route: Route) => {
    route.fulfill({ json: { agents: [] } });
  });

  await page.route('**/api/jobs/notifications', (route: Route) => {
    route.fulfill({ json: { notifications: [] } });
  });
}

test.describe('Projects table pause state', () => {
  test('does not show scheduled pause when another provider is available', async ({ page }) => {
    await mockProjectsTable(page, null);

    await page.goto('/');

    await expect(page.getByRole('switch', { name: 'Pause jobs' })).toBeVisible();
    await expect(page.getByText(PROJECT)).toBeVisible();
    await expect(page.getByText('scheduled paused')).toHaveCount(0);
    await expect(page.getByText('now')).toBeVisible();
  });

  test('shows scheduled pause only when the server says every provider is throttled', async ({ page }) => {
    await mockProjectsTable(page, {
      reason: '7d burn rate too high: 90% used, projected 630%',
      projectedPct: 630,
      worstProvider: 'claude',
      resumesAtMs: Date.now() + 60_000,
    });

    await page.goto('/');

    await expect(page.getByRole('switch', { name: /Scheduled agents paused/ })).toBeVisible();
    await expect(page.getByText(PROJECT)).toBeVisible();
    await expect(page.getByText('scheduled paused')).toHaveCount(3);
    await expect(page.getByText('now')).toHaveCount(0);
  });
});
