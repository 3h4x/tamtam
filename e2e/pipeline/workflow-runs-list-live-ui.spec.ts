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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
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
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
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
  test('page already open picks up two newly-started runs, then isolates one failure while the other stays active', async ({
    page,
  }) => {
    let phase: 'idle' | 'both-running' | 'one-failed' = 'idle';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => {
      if (phase === 'idle') return [];
      if (phase === 'both-running') {
        return [
          makeRun('running', {
            id: 'workflow-run-start-failing',
            input: ['workflow-start-failing', { triggeredBy: 'agent-failing' }],
          }),
          makeRun('running', {
            id: 'workflow-run-start-steady',
            input: ['workflow-start-steady', { triggeredBy: 'agent-steady' }],
          }),
        ];
      }
      return [
        makeRun('failed', {
          id: 'workflow-run-start-failing',
          input: ['workflow-start-failing', { triggeredBy: 'agent-failing' }],
          error: 'release orchestration failed after review',
        }),
        makeRun('running', {
          id: 'workflow-run-start-steady',
          input: ['workflow-start-steady', { triggeredBy: 'agent-steady' }],
        }),
      ];
    });

    await page.goto('/workflow-runs');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    phase = 'both-running';

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible({ timeout: 12_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-start-failing/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-start-steady/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(
      activePanel.getByRole('link', {
        name: /workflow run release orchestrator for workflow-start-steady.* state running/i,
      }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 12_000 });

    phase = 'one-failed';

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const failedRow = attentionPanel.getByRole('link', { name: /workflow-start-failing/i }).first();
    await expect(activePanel.getByText('1 run')).toBeVisible({ timeout: 12_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-start-failing/i }),
    ).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(
      activePanel.getByRole('link', { name: /workflow-start-steady/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(failedRow).toBeVisible({ timeout: 12_000 });
    await expect(
      attentionPanel.getByRole('link', {
        name: /workflow run release orchestrator for workflow-start-failing.* state failed/i,
      }).first(),
    ).toBeVisible({ timeout: 12_000 });
    await expect(failedRow.getByLabel('status failed')).toBeVisible({ timeout: 12_000 });
    await expect(attentionPanel.getByText('release orchestration failed after review')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /failed 1/i })).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });
  });

  test('page already open picks up a newly-started run, then settles to completed without reload', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'completed' = 'idle';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => {
      if (phase === 'idle') return [];
      if (phase === 'running') return [makeRun('running')];
      return [makeRun('completed', { output: { verdict: 'LGTM' } })];
    });

    await page.goto('/workflow-runs');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /release orchestrator/i })).toHaveCount(0);

    phase = 'running';

    const activePanel = page.getByLabel('Active workflow runs');
    const runningBadge = activePanel.getByLabel('status running').first();
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(runningBadge).toBeVisible({ timeout: 12_000 });
    await expect(runningBadge.locator('.animate-spin')).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByText(PROJECT)).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });

    phase = 'completed';

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    const completedRow = page.getByRole('row').filter({ hasText: PROJECT }).first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedRow.locator('.animate-spin')).toHaveCount(0);
    await expect(completedRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
  });

  test('attention panel keeps the review summary visible when a completed run ends with DO NOT SHIP', async ({
    page,
  }) => {
    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      makeRun('completed', {
        id: 'workflow-run-review-dns',
        input: ['workflow-review-dns', { triggeredBy: 'agent-review' }],
        output: {
          decision: {
            verdict: 'DO NOT SHIP',
            summary: 'Critical security vulnerabilities remain in the release candidate.',
          },
        },
      }),
    ]);

    await page.goto('/workflow-runs');

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const attentionRow = attentionPanel.getByRole('link', { name: /workflow-review-dns/i }).first();
    await expect(attentionPanel).toBeVisible({ timeout: 8_000 });
    await expect(attentionRow.getByLabel('status completed')).toBeVisible({ timeout: 8_000 });
    await expect(attentionRow.getByText('DO NOT SHIP')).toBeVisible({ timeout: 8_000 });
    await expect(
      attentionRow.getByText('Critical security vulnerabilities remain in the release candidate.'),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('completed workflow with a cancelled waited job remains completed with a cancelled outcome label', async ({
    page,
  }) => {
    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      makeRun('completed', {
        id: 'workflow-run-cancelled-waited',
        input: ['workflow-cancelled-waited', { triggeredBy: 'agent-cancelled' }],
        output: {
          waited: {
            job: {
              exitCode: -3,
              detail: 'release was cancelled before completion',
            },
          },
        },
      }),
    ]);

    await page.goto('/workflow-runs');

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const cancelledRow = attentionPanel.getByRole('link', { name: /workflow-cancelled-waited/i }).first();
    await expect(attentionPanel).toBeVisible({ timeout: 8_000 });
    await expect(cancelledRow.getByLabel('status completed')).toBeVisible({ timeout: 8_000 });
    await expect(cancelledRow.locator('[title="cancelled"]').first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(cancelledRow.getByText('exit -3')).toHaveCount(0);
    await expect(cancelledRow.getByText('release was cancelled before completion')).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: /^cancelled 0$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^completed 1$/i })).toBeVisible();
  });

  test('completed workflow with a direct cancelled exit code is normalized to cancelled', async ({
    page,
  }) => {
    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      makeRun('completed', {
        id: 'workflow-run-direct-cancelled',
        input: ['workflow-direct-cancelled', { triggeredBy: 'agent-cancelled' }],
        output: {
          exitCode: -3,
          detail: 'release was cancelled by the workflow',
        },
      }),
    ]);

    await page.goto('/workflow-runs');

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const cancelledRow = attentionPanel.getByRole('link', { name: /workflow-direct-cancelled/i }).first();
    await expect(attentionPanel).toBeVisible({ timeout: 8_000 });
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible({ timeout: 8_000 });
    await expect(cancelledRow.getByText('exit -3')).toHaveCount(0);
    await expect(cancelledRow.getByText('release was cancelled by the workflow')).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: /^cancelled 1$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^completed 0$/i })).toBeVisible();
  });

  test('page already open moves a newly-started run into attention when it fails', async ({
    page,
  }) => {
    let phase: 'idle' | 'running' | 'failed' = 'idle';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => {
      if (phase === 'idle') return [];
      if (phase === 'running') return [makeRun('running')];
      return [makeRun('failed', { error: 'release orchestration failed after push' })];
    });

    await page.goto('/workflow-runs');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    phase = 'running';

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByLabel('status running').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(activePanel.getByText(PROJECT)).toBeVisible({ timeout: 12_000 });

    phase = 'failed';

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(attentionPanel).toBeVisible({ timeout: 12_000 });
    await expect(attentionPanel.getByLabel('status failed')).toBeVisible({ timeout: 12_000 });
    await expect(attentionPanel.getByText('release orchestration failed after push')).toBeVisible({
      timeout: 12_000,
    });
    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /failed 1/i })).toBeVisible({ timeout: 12_000 });
  });

  test('active run moves to completed outcome without reload', async ({ page }) => {
    let serveRunning = true;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      serveRunning
        ? makeRun('running')
        : makeRun('completed', { output: { verdict: 'LGTM' } }),
    ]);

    await page.goto('/workflow-runs');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel('Active workflow runs')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel('Active workflow runs').getByText('active now')).toBeVisible();
    await expect(page.getByLabel('status running').first()).toBeVisible();
    await expect(page.getByText('1 running')).toBeVisible();
    await expect(page.getByRole('link', { name: /release orchestrator/i }).first()).toBeVisible();
    await expect(page.getByText(PROJECT).first()).toBeVisible();

    const stableUrl = page.url();
    serveRunning = false;

    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0, { timeout: 12_000 });
    const completedRow = page.getByRole('row').filter({ hasText: PROJECT }).first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });

  test('active run completing with not-ok output moves to attention without a stale running badge', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      serveRunning
        ? makeRun('running', {
            id: 'workflow-run-completed-not-ok',
            input: ['workflow-completed-not-ok', { triggeredBy: 'agent-warning' }],
          })
        : makeRun('completed', {
            id: 'workflow-run-completed-not-ok',
            input: ['workflow-completed-not-ok', { triggeredBy: 'agent-warning' }],
            output: {
              ok: false,
              message: 'release finished but post-checks still need operator review',
            },
          }),
    ]);

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-completed-not-ok/i }),
    ).toBeVisible();
    await expect(activePanel.getByLabel('status running')).toBeVisible();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();

    const stableUrl = page.url();
    serveRunning = false;

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const warningRow = attentionPanel
      .getByRole('link', { name: /workflow-completed-not-ok/i })
      .first();
    await expect(attentionPanel).toBeVisible({ timeout: 12_000 });
    await expect(warningRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(warningRow.getByText('not ok')).toBeVisible({ timeout: 12_000 });
    await expect(
      warningRow.getByText('release finished but post-checks still need operator review'),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^running 0$/i })).toBeVisible();
    await expect(page.getByText('1 running')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^completed 1$/i })).toBeVisible();
    await expect(page).toHaveURL(stableUrl);
  });

  test('active run disappearing from the backend clears active state without an orphaned spinner', async ({
    page,
  }) => {
    let includeRun = true;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => (includeRun ? [makeRun('running')] : []));

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByLabel('status running').first()).toBeVisible();
    await expect(activePanel.getByRole('link', { name: /release orchestrator/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();
    await expect(page.getByText('1 running')).toBeVisible();

    const stableUrl = page.url();
    includeRun = false;

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^running 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('link', { name: /release orchestrator/i })).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });

  test('pending workflow becomes running and then completed without stale status counts', async ({
    page,
  }) => {
    let phase: 'pending' | 'running' | 'completed' = 'pending';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => {
      if (phase === 'pending') {
        return [
          makeRun('pending', {
            startedAt: null,
            durationMs: null,
          }),
        ];
      }
      if (phase === 'running') return [makeRun('running')];
      return [makeRun('completed', { output: { verdict: 'LGTM' } })];
    });

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByLabel('status pending')).toBeVisible();
    await expect(page.getByRole('button', { name: /^pending 1$/i })).toBeVisible();
    await expect(page.getByText('1 running')).toHaveCount(0);

    phase = 'running';

    await expect(activePanel.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByLabel('status pending')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^pending 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });

    phase = 'completed';

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    const completedRow = page.getByRole('row').filter({ hasText: PROJECT }).first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^pending 0$/i })).toBeVisible();
  });

  test('pending workflow cancelled before start moves to attention without stale active state', async ({
    page,
  }) => {
    let phase: 'pending' | 'cancelled' = 'pending';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      phase === 'pending'
        ? makeRun('pending', {
            startedAt: null,
            durationMs: null,
          })
        : makeRun('cancelled', {
            startedAt: null,
            error: 'release was cancelled before a worker started',
          }),
    ]);

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByLabel('status pending')).toBeVisible();
    await expect(page.getByRole('button', { name: /^pending 1$/i })).toBeVisible();
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    const stableUrl = page.url();
    phase = 'cancelled';

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(attentionPanel).toBeVisible({ timeout: 12_000 });
    const cancelledRow = attentionPanel.getByRole('link', { name: /state cancelled/i }).first();
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(
      cancelledRow.getByText('release was cancelled before a worker started'),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^pending 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^cancelled 1$/i })).toBeVisible();
    await expect(page.getByText('1 running')).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });

  test('pending workflow keeps the stale active row when a refresh returns 404, then recovers to cancelled without an orphaned pending badge', async ({
    page,
  }) => {
    let pollCount = 0;

    await stubWorkflowRunsShell(page);
    await page.route(
      (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
      (route: Route) => {
        pollCount += 1;

        if (pollCount === 1) {
          return route.fulfill({
            json: {
              runs: [
                makeRun('pending', {
                  id: 'workflow-run-pending-404-recovery',
                  input: ['workflow-pending-404-recovery', { triggeredBy: 'agent-pending' }],
                  startedAt: null,
                  durationMs: null,
                }),
              ],
              meta: {
                workflowEnabled: true,
                releaseWorkflow: true,
                releaseWorkflowDrive: true,
                mode: 'drive',
              },
            },
          });
        }

        if (pollCount === 2) {
          return route.fulfill({
            status: 404,
            json: { detail: 'workflow run not found' },
          });
        }

        return route.fulfill({
          json: {
            runs: [
              makeRun('cancelled', {
                id: 'workflow-run-pending-404-recovery',
                input: ['workflow-pending-404-recovery', { triggeredBy: 'agent-pending' }],
                startedAt: null,
                error: 'release was cancelled before a worker resumed the pending run',
              }),
            ],
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

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    const pendingRow = activePanel
      .getByRole('link', { name: /workflow-pending-404-recovery/i })
      .first();

    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(pendingRow.getByLabel('status pending')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /^pending 1$/i })).toBeVisible({ timeout: 8_000 });

    await expect(page.getByText('Refresh failed. Showing last successful results.')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('workflow run not found')).toBeVisible({ timeout: 12_000 });
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(pendingRow.getByLabel('status pending')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^pending 1$/i })).toBeVisible({ timeout: 12_000 });

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const cancelledRow = attentionPanel
      .getByRole('link', { name: /workflow-pending-404-recovery/i })
      .first();

    await expect(page.getByText('Refresh failed. Showing last successful results.')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByText('workflow run not found')).toHaveCount(0, { timeout: 12_000 });
    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(attentionPanel).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(
      cancelledRow.getByText('release was cancelled before a worker resumed the pending run'),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^pending 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^cancelled 1$/i })).toBeVisible({
      timeout: 12_000,
    });
  });

  test('pending workflow failed before start moves to attention without stale pending state', async ({
    page,
  }) => {
    let phase: 'pending' | 'failed' = 'pending';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      phase === 'pending'
        ? makeRun('pending', {
            id: 'workflow-run-pending-start-failed',
            input: ['workflow-pending-start-failed', { triggeredBy: 'worker-start' }],
            startedAt: null,
            durationMs: null,
          })
        : makeRun('failed', {
            id: 'workflow-run-pending-start-failed',
            input: ['workflow-pending-start-failed', { triggeredBy: 'worker-start' }],
            startedAt: null,
            error: 'workflow worker failed before starting release execution',
          }),
    ]);

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-pending-start-failed/i }),
    ).toBeVisible();
    await expect(activePanel.getByLabel('status pending')).toBeVisible();
    await expect(page.getByRole('button', { name: /^pending 1$/i })).toBeVisible();
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    const stableUrl = page.url();
    phase = 'failed';

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(attentionPanel).toBeVisible({ timeout: 12_000 });
    const failedRow = attentionPanel.getByRole('link', { name: /state failed/i }).first();
    await expect(failedRow.getByLabel('status failed')).toBeVisible({ timeout: 12_000 });
    await expect(
      failedRow.getByText('workflow worker failed before starting release execution'),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^pending 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^failed 1$/i })).toBeVisible();
    await expect(page.getByText('1 running')).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });

  test('pending workflow disappearing from the backend clears the active panel without a stale pending count', async ({
    page,
  }) => {
    let includeRun = true;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => (
      includeRun
        ? [
            makeRun('pending', {
              id: 'workflow-run-pending-disappeared',
              input: ['workflow-pending-disappeared', { triggeredBy: 'queue-worker' }],
              startedAt: null,
              durationMs: null,
            }),
          ]
        : []
    ));

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-pending-disappeared/i }),
    ).toBeVisible();
    await expect(activePanel.getByLabel('status pending')).toBeVisible();
    await expect(page.getByRole('button', { name: /^pending 1$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^running 0$/i })).toBeVisible();
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    const stableUrl = page.url();
    includeRun = false;

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^pending 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    await expect(
      page.getByRole('link', { name: /workflow-pending-disappeared/i }),
    ).toHaveCount(0);
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
    await expect(page.locator('[aria-label="status running"]')).toHaveCount(0);
    await expect(page.getByText('1 running')).toHaveCount(0);
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
    const cancelledRow = attentionPanel.getByRole('link', { name: /state cancelled/i }).first();
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible();
    await expect(cancelledRow).toContainText('cancelled');
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /cancelled 1/i })).toBeVisible();
    await expect(page).toHaveURL(stableUrl);
  });

  test('active run completing with a direct cancelled exit code normalizes to cancelled without a stale completed state', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      serveRunning
        ? makeRun('running', {
            id: 'workflow-run-live-direct-cancelled',
            input: ['workflow-live-direct-cancelled', { triggeredBy: 'agent-cancelled' }],
          })
        : makeRun('completed', {
            id: 'workflow-run-live-direct-cancelled',
            input: ['workflow-live-direct-cancelled', { triggeredBy: 'agent-cancelled' }],
            output: {
              exitCode: -3,
              detail: 'release was cancelled by the workflow after it started',
            },
          }),
    ]);

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-live-direct-cancelled/i }),
    ).toBeVisible();
    await expect(activePanel.getByLabel('status running')).toBeVisible();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();

    const stableUrl = page.url();
    serveRunning = false;

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const cancelledRow = attentionPanel
      .getByRole('link', { name: /workflow-live-direct-cancelled/i })
      .first();
    await expect(attentionPanel).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(
      cancelledRow.getByText('release was cancelled by the workflow after it started'),
    ).toBeVisible({
      timeout: 12_000,
    });
    await expect(cancelledRow.getByText('exit -3')).toHaveCount(0);
    await expect(cancelledRow.getByLabel('status completed')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^running 0$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^cancelled 1$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^completed 0$/i })).toBeVisible();
    await expect(page).toHaveURL(stableUrl);
  });

  test('two active runs stay isolated when one completes and the other keeps running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'one-completed' | 'all-completed' = 'both-running';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => {
      if (phase === 'both-running') {
        return [
          makeRun('running', { id: 'workflow-run-alpha', input: ['workflow-alpha', { triggeredBy: 'agent-a' }] }),
          makeRun('running', { id: 'workflow-run-beta', input: ['workflow-beta', { triggeredBy: 'agent-b' }] }),
        ];
      }

      if (phase === 'one-completed') {
        return [
          makeRun('completed', {
            id: 'workflow-run-alpha',
            input: ['workflow-alpha', { triggeredBy: 'agent-a' }],
            output: { verdict: 'LGTM' },
          }),
          makeRun('running', { id: 'workflow-run-beta', input: ['workflow-beta', { triggeredBy: 'agent-b' }] }),
        ];
      }

      return [
        makeRun('completed', {
          id: 'workflow-run-alpha',
          input: ['workflow-alpha', { triggeredBy: 'agent-a' }],
          output: { verdict: 'LGTM' },
        }),
        makeRun('completed', {
          id: 'workflow-run-beta',
          input: ['workflow-beta', { triggeredBy: 'agent-b' }],
          output: { verdict: 'LGTM' },
        }),
      ];
    });

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible();
    await expect(activePanel.getByRole('link', { name: /workflow-alpha/i })).toBeVisible();
    await expect(activePanel.getByRole('link', { name: /workflow-beta/i })).toBeVisible();
    await expect(page.getByText('2 running')).toBeVisible();

    phase = 'one-completed';

    await expect(activePanel.getByText('1 run')).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByRole('link', { name: /workflow-alpha/i })).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(activePanel.getByRole('link', { name: /workflow-beta/i })).toBeVisible();
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });

    const completedAlphaRow = page.getByRole('row').filter({ hasText: 'workflow-alpha' }).first();
    await expect(completedAlphaRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedAlphaRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });

    phase = 'all-completed';

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });

    const completedBetaRow = page.getByRole('row').filter({ hasText: 'workflow-beta' }).first();
    await expect(completedBetaRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedBetaRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
  });

  test('idle page picks up two newly-started runs, then isolates one completion while the other stays active', async ({
    page,
  }) => {
    let phase: 'idle' | 'both-running' | 'one-completed' = 'idle';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => {
      if (phase === 'idle') return [];

      if (phase === 'both-running') {
        return [
          makeRun('running', {
            id: 'workflow-run-idle-alpha',
            input: ['workflow-idle-alpha', { triggeredBy: 'agent-alpha' }],
          }),
          makeRun('running', {
            id: 'workflow-run-idle-beta',
            input: ['workflow-idle-beta', { triggeredBy: 'agent-beta' }],
          }),
        ];
      }

      return [
        makeRun('completed', {
          id: 'workflow-run-idle-alpha',
          input: ['workflow-idle-alpha', { triggeredBy: 'agent-alpha' }],
          output: { verdict: 'LGTM' },
        }),
        makeRun('running', {
          id: 'workflow-run-idle-beta',
          input: ['workflow-idle-beta', { triggeredBy: 'agent-beta' }],
        }),
      ];
    });

    await page.goto('/workflow-runs');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);

    phase = 'both-running';

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible({ timeout: 12_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-idle-alpha/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-idle-beta/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /running 2/i })).toBeVisible({
      timeout: 12_000,
    });

    phase = 'one-completed';

    await expect(activePanel.getByText('1 run')).toBeVisible({ timeout: 12_000 });
    await expect(
      activePanel.getByRole('link', { name: /workflow-idle-alpha/i }),
    ).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(
      activePanel.getByRole('link', { name: /workflow-idle-beta/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /running 1/i })).toBeVisible({
      timeout: 12_000,
    });

    const completedRow = page.getByRole('row').filter({ hasText: 'workflow-idle-alpha' }).first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
  });

  test('two active runs stay isolated when one fails into attention and the other keeps running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'one-failed' | 'done' = 'both-running';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => {
      if (phase === 'both-running') {
        return [
          makeRun('running', {
            id: 'workflow-run-failing',
            input: ['workflow-failing', { triggeredBy: 'agent-failing' }],
          }),
          makeRun('running', {
            id: 'workflow-run-steady',
            input: ['workflow-steady', { triggeredBy: 'agent-steady' }],
          }),
        ];
      }

      if (phase === 'one-failed') {
        return [
          makeRun('failed', {
            id: 'workflow-run-failing',
            input: ['workflow-failing', { triggeredBy: 'agent-failing' }],
            error: 'release orchestration failed after review',
          }),
          makeRun('running', {
            id: 'workflow-run-steady',
            input: ['workflow-steady', { triggeredBy: 'agent-steady' }],
          }),
        ];
      }

      return [
        makeRun('failed', {
          id: 'workflow-run-failing',
          input: ['workflow-failing', { triggeredBy: 'agent-failing' }],
          error: 'release orchestration failed after review',
        }),
        makeRun('completed', {
          id: 'workflow-run-steady',
          input: ['workflow-steady', { triggeredBy: 'agent-steady' }],
          output: { verdict: 'LGTM' },
        }),
      ];
    });

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible();
    await expect(activePanel.getByRole('link', { name: /workflow-failing/i })).toBeVisible();
    await expect(activePanel.getByRole('link', { name: /workflow-steady/i })).toBeVisible();
    await expect(page.getByText('2 running')).toBeVisible();
    await expect(attentionPanel).toHaveCount(0);

    phase = 'one-failed';

    const failedRow = attentionPanel.getByRole('link', { name: /workflow-failing/i }).first();
    await expect(activePanel.getByText('1 run')).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByRole('link', { name: /workflow-failing/i })).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(activePanel.getByRole('link', { name: /workflow-steady/i })).toBeVisible();
    await expect(failedRow).toBeVisible({ timeout: 12_000 });
    await expect(failedRow.getByLabel('status failed')).toBeVisible({ timeout: 12_000 });
    await expect(attentionPanel.getByText('release orchestration failed after review')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /failed 1/i })).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });

    phase = 'done';

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    await expect(failedRow).toBeVisible();

    const completedRow = page.getByRole('row').filter({ hasText: 'workflow-steady' }).first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
  });

  test('two active runs stay isolated when one is cancelled and the other keeps running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'one-cancelled' | 'done' = 'both-running';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => {
      if (phase === 'both-running') {
        return [
          makeRun('running', {
            id: 'workflow-run-cancelled',
            input: ['workflow-cancelled', { triggeredBy: 'agent-cancelled' }],
          }),
          makeRun('running', {
            id: 'workflow-run-steady-cancel-peer',
            input: ['workflow-steady-cancel-peer', { triggeredBy: 'agent-steady' }],
          }),
        ];
      }

      if (phase === 'one-cancelled') {
        return [
          makeRun('cancelled', {
            id: 'workflow-run-cancelled',
            input: ['workflow-cancelled', { triggeredBy: 'agent-cancelled' }],
            error: 'release was cancelled before completion',
          }),
          makeRun('running', {
            id: 'workflow-run-steady-cancel-peer',
            input: ['workflow-steady-cancel-peer', { triggeredBy: 'agent-steady' }],
          }),
        ];
      }

      return [
        makeRun('cancelled', {
          id: 'workflow-run-cancelled',
          input: ['workflow-cancelled', { triggeredBy: 'agent-cancelled' }],
          error: 'release was cancelled before completion',
        }),
        makeRun('completed', {
          id: 'workflow-run-steady-cancel-peer',
          input: ['workflow-steady-cancel-peer', { triggeredBy: 'agent-steady' }],
          output: { verdict: 'LGTM' },
        }),
      ];
    });

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible();
    await expect(activePanel.getByRole('link', { name: /workflow-cancelled/i })).toBeVisible();
    await expect(
      activePanel.getByRole('link', { name: /workflow-steady-cancel-peer/i }),
    ).toBeVisible();
    await expect(page.getByText('2 running')).toBeVisible();
    await expect(attentionPanel).toHaveCount(0);

    phase = 'one-cancelled';

    const cancelledRow = attentionPanel.getByRole('link', { name: /workflow-cancelled/i }).first();
    await expect(activePanel.getByText('1 run')).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByRole('link', { name: /workflow-cancelled/i })).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(
      activePanel.getByRole('link', { name: /workflow-steady-cancel-peer/i }),
    ).toBeVisible();
    await expect(cancelledRow).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByText('release was cancelled before completion')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /cancelled 1/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });

    phase = 'done';

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    await expect(cancelledRow).toBeVisible();

    const completedRow = page.getByRole('row')
      .filter({ hasText: 'workflow-steady-cancel-peer' })
      .first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
  });
});
