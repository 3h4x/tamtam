import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

const PROJECT = 'workflow-runs-pause-transition-ui';
const RUN_ID = 'workflow-runs-pause-transition-ui-run-1';

type WorkflowStatus = 'running' | 'completed';

function iso(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function workflowRun(status: WorkflowStatus) {
  const completed = status === 'completed';
  return {
    id: RUN_ID,
    name: 'release',
    rawName: 'release',
    status,
    createdAt: iso(90),
    startedAt: iso(80),
    completedAt: completed ? iso(2) : null,
    durationMs: completed ? 78_000 : null,
    input: {
      projectName: PROJECT,
      trigger: completed ? 'release completed after pause' : 'release button',
    },
    output: completed
      ? {
          status: 'success',
          exitCode: 0,
          summary: 'Release finished while jobs were paused globally.',
        }
      : null,
    error: null,
  };
}

async function stubWorkflowRunsShell(
  page: import('@playwright/test').Page,
  getStatus: () => WorkflowStatus,
  getJobsPaused: () => boolean,
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) => route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/usage/quota', (route: Route) =>
    route.fulfill({
      json: {
        gateEnabled: false,
        fiveHour: { utilization: 0, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 0, resetsAt: null, msUntilReset: null },
      },
    }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: {
          jobs_paused: getJobsPaused() ? 'true' : 'false',
          rebuild_in_progress: 'false',
        },
        github_owner: '',
      },
    }),
  );
  await page.route(
    (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
    (route: Route) =>
      route.fulfill({
        json: {
          runs: [workflowRun(getStatus())],
          meta: {
            workflowEnabled: true,
            releaseWorkflow: true,
            releaseWorkflowDrive: true,
            mode: 'drive',
          },
        },
      }),
  );
}

test.describe('Workflow-runs paused lifecycle transition', () => {
  test('active run completes while jobs are paused without leaving an orphan active panel', async ({
    page,
  }) => {
    let status: WorkflowStatus = 'running';
    let jobsPaused = false;

    await stubWorkflowRunsShell(page, () => status, () => jobsPaused);

    await page.goto('/workflow-runs');

    const stableUrl = page.url();
    const pauseSwitch = page.getByRole('switch');
    const activePanel = page.getByLabel('Active workflow runs');

    await expect(pauseSwitch).toHaveText('jobs running', { timeout: 8_000 });
    await expect(pauseSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(
      activePanel.getByRole('link', {
        name: new RegExp(`Workflow run release for ${PROJECT} state running`),
      }),
    ).toBeVisible();
    await expect(page.getByText('1 recent · refresh every 5s')).toBeVisible();

    jobsPaused = true;
    status = 'completed';

    await expect(pauseSwitch).toHaveText('jobs paused', { timeout: 12_000 });
    await expect(pauseSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('link', { name: 'Release' }).first()).toBeVisible({
      timeout: 12_000,
    });
    const completedRow = page.getByRole('row').filter({ hasText: PROJECT }).filter({ hasText: 'exit 0' });
    await expect(completedRow).toBeVisible();
    await expect(page).toHaveURL(stableUrl);
  });
});
