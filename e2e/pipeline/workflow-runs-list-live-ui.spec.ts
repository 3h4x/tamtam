import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const RUN_ID = 'workflow-list-live-001';
const PROJECT = 'workflow-list-live';
const CREATED_AT = '2026-05-29T10:00:00.000Z';
const STARTED_AT = '2026-05-29T10:00:02.000Z';
const COMPLETED_AT = '2026-05-29T10:00:14.000Z';

type WorkflowRunSummary = {
  id: string;
  name: string;
  rawName: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
};

function makeRun(
  status: WorkflowRunSummary['status'],
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  const terminal = status === 'completed' || status === 'failed';
  return {
    id: RUN_ID,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status,
    createdAt: CREATED_AT,
    startedAt: STARTED_AT,
    completedAt: terminal ? COMPLETED_AT : null,
    durationMs: terminal ? 12_000 : null,
    input: [PROJECT, { triggeredBy: 'agent-run-123' }],
    output: null,
    error: null,
    ...overrides,
  };
}

async function stubWorkflowRunsShell(page: Page): Promise<void> {
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
    (route: Route) =>
      route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  );
}

async function stubWorkflowRuns(page: Page, runs: () => WorkflowRunSummary[]): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
    (route: Route) =>
      route.fulfill({
        json: {
          runs: runs(),
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

test.describe('Workflow runs list live polling', () => {
  test('active run moves to completed outcome without reload', async ({ page }) => {
    let serveRunning = true;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      serveRunning
        ? makeRun('running')
        : makeRun('completed', { output: { verdict: 'LGTM' } }),
    ]);

    await page.goto('/workflow-runs');

    await expect(page.getByRole('heading', { name: 'Workflow runs' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel('Active workflow runs')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel('Active workflow runs').getByText('active now')).toBeVisible();
    await expect(page.getByLabel('status running').first()).toBeVisible();
    await expect(page.getByText('1 running')).toBeVisible();
    await expect(page.getByRole('link', { name: /release-orchestrator/i }).first()).toBeVisible();
    await expect(page.getByText(PROJECT).first()).toBeVisible();

    const stableUrl = page.url();
    serveRunning = false;

    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByLabel('status completed').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('LGTM').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });

  test('active run moves to attention panel when the workflow fails', async ({ page }) => {
    let serveRunning = true;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      serveRunning
        ? makeRun('running')
        : makeRun('failed', { error: 'release orchestration failed after review' }),
    ]);

    await page.goto('/workflow-runs');

    await expect(page.getByLabel('Active workflow runs')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel('status running').first()).toBeVisible();
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    serveRunning = false;

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(attentionPanel).toBeVisible({ timeout: 12_000 });
    await expect(attentionPanel.getByText('needs attention')).toBeVisible();
    await expect(attentionPanel.getByLabel('status failed')).toBeVisible();
    await expect(attentionPanel.getByText('release orchestration failed after review')).toBeVisible();
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /failed 1/i })).toBeVisible();
  });

  test('active run moves to cancelled attention state without reload', async ({ page }) => {
    let serveRunning = true;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      serveRunning
        ? makeRun('running')
        : makeRun('cancelled', { error: 'release was cancelled before completion' }),
    ]);

    await page.goto('/workflow-runs');

    await expect(page.getByLabel('Active workflow runs')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel('status running').first()).toBeVisible();
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    const stableUrl = page.url();
    serveRunning = false;

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(attentionPanel).toBeVisible({ timeout: 12_000 });
    await expect(attentionPanel.getByText('needs attention')).toBeVisible();
    await expect(attentionPanel.getByLabel('status cancelled')).toBeVisible();
    await expect(attentionPanel.getByText('release was cancelled before completion')).toBeVisible();
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /cancelled 1/i })).toBeVisible();
    await expect(page).toHaveURL(stableUrl);
  });
});
