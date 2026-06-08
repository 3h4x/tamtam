import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Mocked-API UI tests for the /logs page.
// Verifies the project picker → logs load → expand/collapse → search filter →
// empty state → error/retry → clear lifecycle. All API calls are intercepted;
// no real pipeline execution.

const PROJECT_A = 'logs-ui-alpha';
const PROJECT_B = 'logs-ui-beta';

function makeTask(project: string) {
  return {
    id: `${project}-1`,
    project,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${project}`,
    fires_at: '',
    sync: true,
    changes: 0,
    unpushed: 0,
    reviewed: true,
    last_run: null,
    last_run_ago: null,
    last_run_duration_s: null,
    last_run_exit: null,
    release_tag: null,
    ci: null,
    ci_failed_url: null,
    github: null,
  };
}

// Mocks the global chrome (settings, notifications) plus the projects list.
// Per-project log responses are wired by each test via `logHandler`.
async function mockLogsScenario(
  page: import('@playwright/test').Page,
  opts: {
    projects?: string[];
    logHandler?: (project: string, route: Route) => void;
  } = {},
): Promise<void> {
  const projects = opts.projects ?? [PROJECT_A, PROJECT_B];

  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );

  // The logs page derives its project picker from the fleet list.
  await page.route(
    (url) => url.pathname === '/api/projects',
    (route: Route) =>
      route.fulfill({
        json: {
          tasks: projects.map(makeTask),
          priorities: [],
          issueCounts: {},
        },
      }),
  );

  // Per-project logs endpoint: /api/projects/by-project/<name>/logs
  await page.route(
    (url) => /\/api\/projects\/by-project\/[^/]+\/logs$/.test(url.pathname),
    (route: Route) => {
      const match = new URL(route.request().url()).pathname.match(
        /\/by-project\/([^/]+)\/logs$/,
      );
      const project = match ? decodeURIComponent(match[1]) : '';
      if (opts.logHandler) {
        opts.logHandler(project, route);
        return;
      }
      route.fulfill({ json: { logs: [] } });
    },
  );
}

test.describe('Logs page UI', () => {
  test('a failed project list fetch shows an error state and retry recovers', async ({ page }) => {
    let failProjects = true;

    await page.route('**/api/settings', (route: Route) =>
      route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
    );
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({ json: { notifications: [] } }),
    );
    await page.route(
      (url) => url.pathname === '/api/projects',
      (route: Route) => {
        if (failProjects) {
          failProjects = false;
          route.fulfill({ status: 500, body: 'temporary project scan failure' });
          return;
        }

        route.fulfill({
          json: {
            tasks: [makeTask(PROJECT_A), makeTask(PROJECT_B)],
            priorities: [],
            issueCounts: {},
          },
        });
      },
    );

    await page.goto('/logs');

    await expect(page.getByText('Failed to load projects.')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: PROJECT_A })).toHaveCount(0);

    await page.getByRole('button', { name: /retry/i }).click();

    await expect(page.getByRole('button', { name: PROJECT_A })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: PROJECT_B })).toBeVisible();
    await expect(page.getByText('Failed to load projects.')).toHaveCount(0);
  });

  test('selecting a project loads its logs and expanding reveals content', async ({ page }) => {
    await mockLogsScenario(page, {
      logHandler: (project, route) =>
        route.fulfill({
          json: {
            logs: [
              { filename: `${project}-run-1.log`, content: 'hello from run one' },
            ],
          },
        }),
    });

    await page.goto('/logs');

    // Project picker shows both projects.
    await expect(page.getByRole('button', { name: PROJECT_A })).toBeVisible();

    await page.getByRole('button', { name: PROJECT_A }).click();

    // Header reflects the selected project; the log filename row appears.
    await expect(page.getByRole('heading', { name: new RegExp(PROJECT_A) })).toBeVisible();
    const logRow = page.getByRole('button', { name: new RegExp(`${PROJECT_A}-run-1\\.log`) });
    await expect(logRow).toBeVisible();

    // Content is collapsed until the row is toggled.
    await expect(page.getByText('hello from run one')).not.toBeVisible();
    await logRow.click();
    await expect(page.getByText('hello from run one')).toBeVisible();

    // Toggling again collapses it.
    await logRow.click();
    await expect(page.getByText('hello from run one')).not.toBeVisible();
  });

  test('search filters log entries by filename and content', async ({ page }) => {
    await mockLogsScenario(page, {
      logHandler: (_project, route) =>
        route.fulfill({
          json: {
            logs: [
              { filename: 'review-42.log', content: 'verdict LGTM' },
              { filename: 'test-7.log', content: 'all green' },
            ],
          },
        }),
    });

    await page.goto('/logs');
    await page.getByRole('button', { name: PROJECT_A }).click();

    // Both rows present before filtering.
    await expect(page.getByRole('button', { name: /review-42\.log/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /test-7\.log/ })).toBeVisible();

    // Filter by filename — only the matching row survives.
    await page.getByPlaceholder('Search logs...').fill('review');
    await expect(page.getByRole('button', { name: /review-42\.log/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /test-7\.log/ })).not.toBeVisible();

    // Filter by content substring present only in the other log.
    await page.getByPlaceholder('Search logs...').fill('all green');
    await expect(page.getByRole('button', { name: /test-7\.log/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /review-42\.log/ })).not.toBeVisible();
  });

  test('a project with no logs shows the empty state', async ({ page }) => {
    await mockLogsScenario(page, {
      logHandler: (_project, route) => route.fulfill({ json: { logs: [] } }),
    });

    await page.goto('/logs');
    await page.getByRole('button', { name: PROJECT_A }).click();

    await expect(page.getByText(`No logs found for ${PROJECT_A}`)).toBeVisible();
  });

  test('a failed logs fetch shows an error state and retry recovers', async ({ page }) => {
    let failNext = true;
    await mockLogsScenario(page, {
      logHandler: (project, route) => {
        if (failNext) {
          failNext = false;
          route.fulfill({ status: 500, body: 'boom' });
          return;
        }
        route.fulfill({
          json: { logs: [{ filename: `${project}-ok.log`, content: 'recovered' }] },
        });
      },
    });

    await page.goto('/logs');
    await page.getByRole('button', { name: PROJECT_A }).click();

    // First load failed — error state, not the empty state.
    await expect(page.getByText('Failed to load logs.')).toBeVisible();
    await expect(page.getByText(`No logs found for ${PROJECT_A}`)).not.toBeVisible();

    // Retry triggers a fresh fetch which now succeeds.
    await page.getByRole('button', { name: /retry/i }).click();
    await expect(page.getByRole('button', { name: new RegExp(`${PROJECT_A}-ok\\.log`) })).toBeVisible();
    await expect(page.getByText('Failed to load logs.')).not.toBeVisible();
  });

  test('clear returns to the project picker', async ({ page }) => {
    await mockLogsScenario(page, {
      logHandler: (project, route) =>
        route.fulfill({ json: { logs: [{ filename: `${project}.log`, content: 'x' }] } }),
    });

    await page.goto('/logs');
    await page.getByRole('button', { name: PROJECT_A }).click();
    await expect(page.getByRole('heading', { name: new RegExp(PROJECT_A) })).toBeVisible();

    await page.getByRole('button', { name: 'clear' }).click();

    // Back to the picker: both project buttons are visible again, no selection header.
    await expect(page.getByRole('button', { name: PROJECT_A })).toBeVisible();
    await expect(page.getByRole('button', { name: PROJECT_B })).toBeVisible();
    await expect(page.getByRole('button', { name: 'clear' })).not.toBeVisible();
  });
});
