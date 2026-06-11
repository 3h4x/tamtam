import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'workflow-runs-initial-retry-ui';
const RUN_ID = 'workflow-runs-initial-retry-ui-run-1';

function iso(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function completedRun() {
  return {
    id: RUN_ID,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status: 'completed',
    createdAt: iso(120),
    startedAt: iso(110),
    completedAt: iso(5),
    durationMs: 105_000,
    input: [PROJECT, { triggeredBy: 'release button' }],
    output: { verdict: 'LGTM' },
    error: null,
  };
}

async function stubWorkflowRunsShell(
  page: Page,
  shouldFail: () => boolean,
): Promise<void> {
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false', rebuild_in_progress: 'false' }, github_owner: '' } }),
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
          json: { detail: 'workflow runtime is still booting' },
        });
      }

      return route.fulfill({
        json: {
          runs: [completedRun()],
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

test.describe('Workflow-runs initial retry recovery', () => {
  test('Retry recovers from an initial workflow-runs load failure and renders the completed run', async ({
    page,
  }) => {
    let failLoad = true;

    await stubWorkflowRunsShell(page, () => failLoad);
    await page.goto('/workflow-runs');

    await expect(page.getByText('Failed to load workflow runs')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('workflow runtime is still booting')).toBeVisible();
    await expect(
      page.getByText('TamTam could not refresh workflow state from /api/workflow-runs.'),
    ).toBeVisible();
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: PROJECT })).toHaveCount(0);

    failLoad = false;
    await page.getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByText('Failed to load workflow runs')).toHaveCount(0, {
      timeout: 8_000,
    });
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await expect(page.getByText('Releases run automatically')).toBeVisible();
    await expect(page.getByText('1 recent · refresh every 5s')).toBeVisible();

    const completedRow = page.getByRole('row').filter({ hasText: PROJECT }).first();
    await expect(completedRow).toBeVisible({ timeout: 8_000 });
    await expect(completedRow.getByLabel('status completed')).toBeVisible();
    await expect(completedRow.getByText('LGTM')).toBeVisible();
    await expect(page.getByRole('button', { name: /^completed 1$/i })).toBeVisible();
  });
});
