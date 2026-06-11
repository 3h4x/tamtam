import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'workflow-runs-filter-transition-ui';
const RUN_ID = 'workflow-runs-filter-transition-ui-run-1';

type WorkflowStatus = 'running' | 'completed';

type WorkflowRunSummary = {
  id: string;
  name: string;
  rawName: string;
  status: WorkflowStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
};

function iso(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function workflowRun(status: WorkflowStatus): WorkflowRunSummary {
  const completed = status === 'completed';
  return {
    id: RUN_ID,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status,
    createdAt: iso(90),
    startedAt: iso(80),
    completedAt: completed ? iso(3) : null,
    durationMs: completed ? 77_000 : null,
    input: [PROJECT, { triggeredBy: 'release button' }],
    output: completed ? { verdict: 'LGTM' } : null,
    error: null,
  };
}

async function stubWorkflowRunsShell(
  page: Page,
  getStatus: () => WorkflowStatus,
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

test.describe('Workflow-runs filter lifecycle transitions', () => {
  test('active running filter becomes empty when its run completes, then clear filters reveals the completed row', async ({
    page,
  }) => {
    let status: WorkflowStatus = 'running';

    await stubWorkflowRunsShell(page, () => status);
    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByLabel('status running')).toBeVisible();

    const runningFilter = page.getByRole('button', { name: /^running 1$/i });
    await expect(runningFilter).toBeVisible({ timeout: 8_000 });
    await runningFilter.click();
    await expect(runningFilter).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('1 recent · refresh every 5s')).toBeVisible();

    status = 'completed';

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^running 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^completed 1$/i })).toBeVisible();
    await expect(page.getByText('0 of 1 recent · refresh every 5s')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('No runs match current filters')).toBeVisible();
    await expect(page.getByText('status=running · query=—')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: PROJECT })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();

    const completedRow = page.getByRole('row').filter({ hasText: PROJECT }).first();
    await expect(completedRow).toBeVisible({ timeout: 8_000 });
    await expect(completedRow.getByLabel('status completed')).toBeVisible();
    await expect(completedRow.getByText('LGTM')).toBeVisible();
    await expect(page.getByText('No runs match current filters')).toHaveCount(0);
    await expect(page.getByText('1 recent · refresh every 5s')).toBeVisible();
  });
});
