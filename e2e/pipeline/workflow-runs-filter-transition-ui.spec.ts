import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'workflow-runs-filter-transition-ui';
const RUN_ID = 'workflow-runs-filter-transition-ui-run-1';

type WorkflowStatus = 'running' | 'completed' | 'failed';

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
  const terminal = completed || status === 'failed';
  return {
    id: RUN_ID,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status,
    createdAt: iso(90),
    startedAt: iso(80),
    completedAt: terminal ? iso(3) : null,
    durationMs: terminal ? 77_000 : null,
    input: [PROJECT, { triggeredBy: 'release button' }],
    output: completed ? { verdict: 'LGTM' } : null,
    error: status === 'failed' ? 'review failed before retry completed' : null,
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

  test('active running filter clears cleanly when the backend drops the run from the recent window', async ({
    page,
  }) => {
    let includeRun = true;

    await stubWorkflowRunsShell(page, () => 'running');
    await page.route(
      (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
      (route: Route) =>
        route.fulfill({
          json: {
            runs: includeRun ? [workflowRun('running')] : [],
            meta: {
              workflowEnabled: true,
              releaseWorkflow: true,
              releaseWorkflowDrive: true,
              mode: 'drive',
            },
          },
        }),
    );

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByLabel('status running')).toBeVisible();

    const runningFilter = page.getByRole('button', { name: /^running 1$/i });
    await expect(runningFilter).toBeVisible({ timeout: 8_000 });
    await runningFilter.click();
    await expect(runningFilter).toHaveAttribute('aria-pressed', 'true');

    const stableUrl = page.url();
    includeRun = false;

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^running 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('row').filter({ hasText: PROJECT })).toHaveCount(0);
    await expect(page.getByText('No runs match current filters')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('status=running · query=—')).toBeVisible();
    await expect(page).toHaveURL(stableUrl);
  });

  test('failed attention filter becomes empty when a failed run is retried and completes', async ({
    page,
  }) => {
    let status: WorkflowStatus = 'failed';

    await stubWorkflowRunsShell(page, () => status);
    await page.goto('/workflow-runs');

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(attentionPanel).toBeVisible({ timeout: 8_000 });
    await expect(attentionPanel.getByLabel('status failed')).toBeVisible();
    await expect(attentionPanel.getByText('review failed before retry completed')).toBeVisible();

    const failedAttentionFilter = page.getByRole('button', {
      name: /^Show failed workflow runs$/i,
    });
    await expect(failedAttentionFilter).toBeVisible({ timeout: 8_000 });
    await failedAttentionFilter.click();
    await expect(page.getByRole('button', { name: /^failed 1$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('1 recent · refresh every 5s')).toBeVisible();

    const stableUrl = page.url();
    status = 'completed';

    await expect(attentionPanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^failed 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^completed 1$/i })).toBeVisible();
    await expect(page.getByText('0 of 1 recent · refresh every 5s')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('No runs match current filters')).toBeVisible();
    await expect(page.getByText('status=failed · query=—')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: PROJECT })).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);

    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();

    const completedRow = page.getByRole('row').filter({ hasText: PROJECT }).first();
    await expect(completedRow).toBeVisible({ timeout: 8_000 });
    await expect(completedRow.getByLabel('status completed')).toBeVisible();
    await expect(completedRow.getByText('LGTM')).toBeVisible();
    await expect(page.getByText('No runs match current filters')).toHaveCount(0);
  });

  test('failed attention filter becomes empty while a failed run is retried and running', async ({
    page,
  }) => {
    let status: WorkflowStatus = 'failed';

    await stubWorkflowRunsShell(page, () => status);
    await page.goto('/workflow-runs');

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(attentionPanel).toBeVisible({ timeout: 8_000 });
    await expect(attentionPanel.getByLabel('status failed')).toBeVisible();
    await expect(attentionPanel.getByText('review failed before retry completed')).toBeVisible();

    const failedAttentionFilter = page.getByRole('button', {
      name: /^Show failed workflow runs$/i,
    });
    await failedAttentionFilter.click();
    await expect(page.getByRole('button', { name: /^failed 1$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const stableUrl = page.url();
    status = 'running';

    await expect(attentionPanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^failed 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();
    await expect(page.getByText('0 of 1 recent · refresh every 5s')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('No runs match current filters')).toBeVisible();
    await expect(page.getByText('review failed before retry completed')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByRole('row').filter({ hasText: PROJECT })).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);

    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();

    const activePanel = page.getByLabel('Active workflow runs');
    const runningRow = activePanel.getByRole('link', { name: /state running/i }).first();
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(runningRow).toBeVisible();
    await expect(runningRow.getByLabel('status running')).toBeVisible();
    await expect(runningRow.locator('.animate-spin')).toBeVisible();
    await expect(runningRow.getByText('review failed before retry completed')).toHaveCount(0);
    await expect(page.getByText('No runs match current filters')).toHaveCount(0);
  });
});
