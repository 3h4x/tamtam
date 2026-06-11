import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT_ALPHA = 'workflow-search-alpha';
const PROJECT_BETA = 'workflow-search-beta';

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

function makeRun(
  id: string,
  project: string,
  status: WorkflowStatus,
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  const completed = status === 'completed';
  return {
    id,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status,
    createdAt: iso(120),
    startedAt: iso(110),
    completedAt: completed ? iso(5) : null,
    durationMs: completed ? 105_000 : null,
    input: [project, { triggeredBy: 'agent-run-search-transition' }],
    output: completed ? { verdict: 'LGTM' } : null,
    error: null,
    ...overrides,
  };
}

async function stubWorkflowRunsShell(
  page: Page,
  betaStatus: () => WorkflowStatus,
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
          runs: [
            makeRun('workflow-search-alpha-run', PROJECT_ALPHA, 'completed', {
              output: { verdict: 'LGTM' },
            }),
            makeRun('workflow-search-beta-run', PROJECT_BETA, betaStatus()),
          ],
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

test.describe('Workflow-runs search lifecycle transitions', () => {
  test('search stays applied while a matching run completes, then clear search restores the full list', async ({
    page,
  }) => {
    let betaStatus: WorkflowStatus = 'running';

    await stubWorkflowRunsShell(page, () => betaStatus);
    await page.goto('/workflow-runs');

    const search = page.getByPlaceholder('Filter workflow, project, trigger, outcome…');
    await expect(search).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('2 recent · refresh every 5s')).toBeVisible({ timeout: 8_000 });

    await search.fill(PROJECT_BETA);

    await expect(page.getByText('showing 1 of 2 recent runs')).toBeVisible();
    await expect(page.locator(`[title="${PROJECT_BETA}"]`).first()).toBeVisible();
    await expect(page.getByText('1 of 2 recent · refresh every 5s')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: PROJECT_ALPHA })).toHaveCount(0);

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByRole('link', { name: new RegExp(PROJECT_BETA, 'i') })).toBeVisible();
    await expect(activePanel.getByLabel('status running')).toBeVisible();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();

    betaStatus = 'completed';

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^running 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^completed 2$/i })).toBeVisible();
    await expect(page.getByText('1 of 2 recent · refresh every 5s')).toBeVisible();

    const betaRow = page.getByRole('row').filter({ hasText: PROJECT_BETA }).first();
    await expect(betaRow).toBeVisible({ timeout: 8_000 });
    await expect(betaRow.getByLabel('status completed')).toBeVisible();
    await expect(betaRow.getByText('LGTM')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: PROJECT_ALPHA })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear search' }).click();

    await expect(search).toHaveValue('');
    await expect(page.getByText('2 recent · refresh every 5s')).toBeVisible();
    await expect(page.locator(`[title="${PROJECT_BETA}"]`)).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: PROJECT_ALPHA })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: PROJECT_BETA })).toBeVisible();
    await expect(page.getByText('No runs match current filters')).toHaveCount(0);
  });
});
