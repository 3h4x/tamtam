import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'workflow-runs-refresh-recovery-ui';
const RUN_ID = 'workflow-runs-refresh-recovery-ui-run-1';

type WorkflowStatus = 'running' | 'completed';

function iso(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function workflowRun(status: WorkflowStatus) {
  const completed = status === 'completed';
  return {
    id: RUN_ID,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status,
    createdAt: iso(90),
    startedAt: iso(80),
    completedAt: completed ? iso(2) : null,
    durationMs: completed ? 78_000 : null,
    input: [PROJECT, { triggeredBy: 'release button' }],
    output: completed ? { verdict: 'LGTM' } : null,
    error: null,
  };
}

async function stubWorkflowRunsShell(
  page: Page,
  getStatus: () => WorkflowStatus,
  shouldFail: () => boolean,
): Promise<void> {
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) => route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
    (route: Route) => {
      if (shouldFail()) {
        return route.fulfill({
          status: 503,
          json: { detail: 'workflow runtime connection reset' },
        });
      }

      return route.fulfill({
        json: {
          runs: [workflowRun(getStatus())],
          meta: {
            workflowEnabled: true,
            releaseWorkflow: true,
            releaseWorkflowDrive: true,
            mode: 'drive',
          },
        },
      });
    },
  );
}

test.describe('Workflow-runs refresh recovery', () => {
  test('transient refresh failure keeps the last live row, then Retry now clears it with the completed state', async ({
    page,
  }) => {
    let status: WorkflowStatus = 'running';
    let failRefresh = false;

    await stubWorkflowRunsShell(page, () => status, () => failRefresh);
    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    const activeRun = activePanel.getByRole('link').filter({ hasText: PROJECT });

    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activeRun).toBeVisible({ timeout: 8_000 });
    await expect(activeRun.getByLabel('status running')).toBeVisible();
    await expect(page.getByText('1 recent · refresh every 5s')).toBeVisible();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();

    failRefresh = true;

    await expect(page.getByText('Refresh failed. Showing last successful results.')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('workflow runtime connection reset')).toBeVisible();
    await expect(activeRun).toBeVisible();
    await expect(activeRun.getByLabel('status running')).toBeVisible();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();

    failRefresh = false;
    status = 'completed';

    await page.getByRole('button', { name: 'Retry now' }).click();

    await expect(page.getByText('Refresh failed. Showing last successful results.')).toHaveCount(0, {
      timeout: 8_000,
    });
    await expect(activePanel).toHaveCount(0, { timeout: 8_000 });

    const completedRow = page.getByRole('row').filter({ hasText: PROJECT }).first();
    await expect(completedRow).toBeVisible({ timeout: 8_000 });
    await expect(completedRow.getByLabel('status completed')).toBeVisible();
    await expect(completedRow.getByText('LGTM')).toBeVisible();
    await expect(page.getByRole('button', { name: /^running 0$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^completed 1$/i })).toBeVisible();
  });
});
