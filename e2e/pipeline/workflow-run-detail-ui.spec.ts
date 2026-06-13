import { test, expect } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';

// WorkflowRunDetail UI tests — verify running/completed/failed/cancelled/404
// edge cases using mocked API. All tests use the configured baseURL; no
// real pipeline execution.

const RUN_ID = 'wfr-test-001';

type RunDetail = {
  run: {
    id: string;
    name: string;
    rawName: string;
    status: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    output: unknown;
    error: string | null;
  };
  steps: Array<{
    stepId: string;
    name: string;
    rawName: string;
    status: string;
    attempt: number;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    input: unknown;
    output: unknown;
    error: string | null;
  }>;
};

function makeRun(
  status: string,
  overrides: Partial<RunDetail['run']> = {},
): RunDetail['run'] {
  const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  return {
    id: RUN_ID,
    name: 'test-workflow',
    rawName: 'test-workflow',
    status,
    createdAt: '2026-05-28T10:00:00.000Z',
    startedAt: '2026-05-28T10:00:01.000Z',
    completedAt: isTerminal ? '2026-05-28T10:00:13.000Z' : null,
    durationMs: isTerminal ? 12000 : null,
    output: null,
    error: null,
    ...overrides,
  };
}

function makeStep(
  stepId: string,
  name: string,
  status: string,
  overrides: Partial<RunDetail['steps'][0]> = {},
): RunDetail['steps'][0] {
  return {
    stepId,
    name,
    rawName: name,
    status,
    attempt: 1,
    createdAt: '2026-05-28T10:00:01.000Z',
    startedAt: '2026-05-28T10:00:01.000Z',
    completedAt: status !== 'running' ? '2026-05-28T10:00:09.000Z' : null,
    durationMs: status !== 'running' ? 8000 : null,
    input: null,
    output: null,
    error: null,
    ...overrides,
  };
}

async function stubShellRoutes(page: Page): Promise<void> {
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) =>
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
}

function visibleStepAttentionLink(page: Page, text: RegExp): Locator {
  return page.locator('a:visible[href^="#workflow-step-"]').filter({ hasText: text }).first();
}

function stepRow(page: Page, stepId: string): Locator {
  return page.locator(`#workflow-step-desktop-${encodeURIComponent(stepId)}`);
}

test.describe('WorkflowRunDetail UI', () => {
  // ---------------------------------------------------------------------------
  // Running state
  // ---------------------------------------------------------------------------
  test('running run shows "live · refreshes every 5s" label and running badge', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: {
          run: makeRun('running'),
          steps: [makeStep('s1', 'fetch-context', 'completed')],
        } satisfies RunDetail,
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });
    // Should NOT show "final snapshot" label
    await expect(page.getByText('final snapshot')).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // Running → completed transition
  // ---------------------------------------------------------------------------
  test('live run transitions to "final snapshot" and shows completed badge after poll', async ({ page }) => {
    let serveRunning = true;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunning
          ? ({
              run: makeRun('running'),
              steps: [makeStep('s1', 'fetch-context', 'running')],
            } satisfies RunDetail)
          : ({
              run: makeRun('completed'),
              steps: [makeStep('s1', 'fetch-context', 'completed')],
            } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });

    serveRunning = false;

    // Component polls every 5s — allow up to 12s for the update
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status completed"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0);
  });

  test('pending run becomes running and then completed without stale detail badges', async ({ page }) => {
    let phase: 'pending' | 'running' | 'completed' = 'pending';

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: phase === 'pending'
          ? ({
              run: makeRun('pending', { startedAt: null }),
              steps: [
                makeStep('s1', 'prepare-release', 'pending', {
                  startedAt: null,
                  completedAt: null,
                  durationMs: null,
                }),
              ],
            } satisfies RunDetail)
          : phase === 'running'
            ? ({
                run: makeRun('running'),
                steps: [makeStep('s1', 'prepare-release', 'running')],
              } satisfies RunDetail)
            : ({
                run: makeRun('completed'),
                steps: [makeStep('s1', 'prepare-release', 'completed')],
              } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    const stableUrl = page.url();
    const stepRowLocator = stepRow(page, 's1');

    await expect(page.locator('[aria-label="status pending"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });
    await expect(stepRowLocator).toContainText('prepare release');
    await expect(stepRowLocator.getByLabel('status pending')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/pending\s*1/i).first()).toBeVisible({ timeout: 8_000 });

    phase = 'running';

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(stepRowLocator.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status pending"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText(/running\s*1/i).first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 12_000 });

    phase = 'completed';

    await expect(page.locator('[aria-label="status completed"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(stepRowLocator.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText(/completed\s*1/i).first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });

  test('pending run cancelled before start clears pending badges and shows a final snapshot', async ({
    page,
  }) => {
    let servePending = true;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: servePending
          ? ({
              run: makeRun('pending', { startedAt: null }),
              steps: [
                makeStep('s1', 'wait-for-release-slot', 'pending', {
                  startedAt: null,
                  completedAt: null,
                  durationMs: null,
                }),
              ],
            } satisfies RunDetail)
          : ({
              run: makeRun('cancelled', {
                startedAt: null,
                error: 'release was cancelled before a worker picked it up',
              }),
              steps: [
                makeStep('s1', 'wait-for-release-slot', 'cancelled', {
                  startedAt: null,
                  completedAt: null,
                  durationMs: null,
                  error: 'release was cancelled before a worker picked it up',
                }),
              ],
            } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    const stableUrl = page.url();
    const stepRowLocator = stepRow(page, 's1');

    await expect(page.locator('[aria-label="status pending"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(stepRowLocator).toContainText('wait for release slot');
    await expect(stepRowLocator.getByLabel('status pending')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/pending\s*1/i).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });

    servePending = false;

    await expect(page.locator('[aria-label="status cancelled"]').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(stepRowLocator.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status pending"]')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByText(/cancelled\s*1/i).first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0);
    await expect(
      page.getByText('release was cancelled before a worker picked it up').first(),
    ).toBeVisible({
      timeout: 12_000,
    });
    await expect(page).toHaveURL(stableUrl);
  });

  test('pending run failed before start clears pending badges and surfaces the failure without a stale live state', async ({
    page,
  }) => {
    let servePending = true;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: servePending
          ? ({
              run: makeRun('pending', { startedAt: null }),
              steps: [
                makeStep('s1', 'wait-for-release-slot', 'pending', {
                  startedAt: null,
                  completedAt: null,
                  durationMs: null,
                }),
              ],
            } satisfies RunDetail)
          : ({
              run: makeRun('failed', {
                startedAt: null,
                error: 'worker crashed before the workflow started running',
              }),
              steps: [
                makeStep('s1', 'wait-for-release-slot', 'failed', {
                  startedAt: null,
                  completedAt: null,
                  durationMs: null,
                  error: 'worker crashed before the workflow started running',
                }),
              ],
            } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    const stableUrl = page.url();
    const stepRowLocator = stepRow(page, 's1');

    await expect(page.locator('[aria-label="status pending"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(stepRowLocator).toContainText('wait for release slot');
    await expect(stepRowLocator.getByLabel('status pending')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/pending\s*1/i).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });

    servePending = false;

    await expect(page.locator('[aria-label="status failed"]').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(stepRowLocator.getByLabel('status failed')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status pending"]')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByText(/failed\s*1/i).first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0);
    await expect(
      page.getByText('worker crashed before the workflow started running').first(),
    ).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('needs attention')).toBeVisible({ timeout: 12_000 });
    await expect(page).toHaveURL(stableUrl);
  });

  test('pending run keeps the prior snapshot when a refresh returns 404, then recovers to a cancelled final snapshot', async ({
    page,
  }) => {
    let pollCount = 0;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) => {
      pollCount += 1;

      if (pollCount === 1) {
        return route.fulfill({
          json: {
            run: makeRun('pending', { startedAt: null }),
            steps: [
              makeStep('s1', 'wait-for-release-slot', 'pending', {
                startedAt: null,
                completedAt: null,
                durationMs: null,
              }),
            ],
          } satisfies RunDetail,
        });
      }

      if (pollCount === 2) {
        return route.fulfill({
          status: 404,
          json: { error: 'workflow run not found' },
        });
      }

      return route.fulfill({
        json: {
          run: makeRun('cancelled', {
            startedAt: null,
            error: 'release was cancelled before a worker resumed the pending run',
          }),
          steps: [
            makeStep('s1', 'wait-for-release-slot', 'cancelled', {
              startedAt: null,
              completedAt: null,
              durationMs: null,
              error: 'release was cancelled before a worker resumed the pending run',
            }),
          ],
        } satisfies RunDetail,
      });
    });

    await page.goto(`/workflow-runs/${RUN_ID}`);

    const stepRowLocator = stepRow(page, 's1');
    const stableUrl = page.url();

    await expect(page.locator('[aria-label="status pending"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(stepRowLocator.getByLabel('status pending')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });

    await expect(page.getByText('workflow run not found')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status pending"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(stepRowLocator.getByLabel('status pending')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toHaveCount(0);

    await expect(page.locator('[aria-label="status cancelled"]').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(stepRowLocator.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status pending"]')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByText('workflow run not found')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0);
    await expect(
      page.getByText('release was cancelled before a worker resumed the pending run').first(),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page).toHaveURL(stableUrl);
  });

  test('live run keeps the prior snapshot when refreshes keep returning 404', async ({ page }) => {
    let pollCount = 0;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) => {
      pollCount += 1;

      if (pollCount === 1) {
        return route.fulfill({
          json: {
            run: makeRun('running'),
            steps: [makeStep('s1', 'run-review', 'running')],
          } satisfies RunDetail,
        });
      }

      return route.fulfill({
        status: 404,
        json: { error: 'workflow run not found' },
      });
    });

    await page.goto(`/workflow-runs/${RUN_ID}`);

    const stableUrl = page.url();
    const stepRowLocator = stepRow(page, 's1');

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(stepRowLocator.getByLabel('status running')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });

    await expect(page.getByText(/Failed to refresh: workflow run not found/i)).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('Workflow run not found')).toHaveCount(0);
    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(stepRowLocator.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });

  test('live run keeps prior completed steps stable while the active step flips to completed after poll', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunning
          ? ({
              run: makeRun('running'),
              steps: [
                makeStep('s1', 'fetch-context', 'completed'),
                makeStep('s2', 'run-review', 'running'),
              ],
            } satisfies RunDetail)
          : ({
              run: makeRun('completed'),
              steps: [
                makeStep('s1', 'fetch-context', 'completed'),
                makeStep('s2', 'run-review', 'completed'),
              ],
            } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    const completedFetchRow = stepRow(page, 's1');
    const runningReviewRow = stepRow(page, 's2');

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(completedFetchRow).toContainText('fetch context');
    await expect(completedFetchRow.getByLabel('status completed')).toBeVisible({ timeout: 8_000 });
    await expect(runningReviewRow).toContainText('run review');
    await expect(runningReviewRow.getByLabel('status running')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });

    serveRunning = false;

    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(runningReviewRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(runningReviewRow.getByLabel('status running')).toHaveCount(0, { timeout: 12_000 });
    await expect(completedFetchRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/completed\s*2/i).first()).toBeVisible({ timeout: 12_000 });
  });

  test('live run transitions to failed final snapshot and surfaces the error after poll', async ({ page }) => {
    let serveRunning = true;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunning
          ? ({
              run: makeRun('running'),
              steps: [makeStep('s1', 'run-review', 'running')],
            } satisfies RunDetail)
          : ({
              run: makeRun('failed', { error: 'release orchestration failed after review' }),
              steps: [
                makeStep('s1', 'run-review', 'failed', {
                  error: 'release orchestration failed after review',
                }),
              ],
            } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('final snapshot')).toHaveCount(0);

    serveRunning = false;

    await expect(page.locator('[aria-label="status failed"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('release orchestration failed after review').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('needs attention')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0);
    await expect(page.locator('[aria-label="status running"]')).toHaveCount(0);
  });

  test('live run transitions to cancelled final snapshot and surfaces the cancelled step after poll', async ({ page }) => {
    let serveRunning = true;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunning
          ? ({
              run: makeRun('running'),
              steps: [makeStep('s1', 'run-review', 'running')],
            } satisfies RunDetail)
          : ({
              run: makeRun('cancelled', { error: 'release was cancelled before completion' }),
              steps: [
                makeStep('s1', 'run-review', 'cancelled', {
                  completedAt: null,
                  durationMs: null,
                  error: 'release was cancelled before completion',
                }),
              ],
            } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('final snapshot')).toHaveCount(0);

    serveRunning = false;

    await expect(page.locator('[aria-label="status cancelled"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('release was cancelled before completion').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(visibleStepAttentionLink(page, /release was cancelled before completion/i)).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0);
    await expect(page.locator('[aria-label="status running"]')).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // Failed run with error message
  // ---------------------------------------------------------------------------
  test('failed run shows error box and failed badge', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: {
          run: makeRun('failed', { error: 'Unhandled exception: connection refused' }),
          steps: [
            makeStep('s1', 'fetch-context', 'completed'),
            makeStep('s2', 'run-review', 'failed', { error: 'Unhandled exception: connection refused' }),
          ],
        } satisfies RunDetail,
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    // Run-level badge
    await expect(page.locator('[aria-label="status failed"]').first()).toBeVisible({ timeout: 8_000 });
    // Error box text
    await expect(page.getByText('Unhandled exception: connection refused').first()).toBeVisible({
      timeout: 8_000,
    });
    // Attention panel
    await expect(page.getByText('needs attention')).toBeVisible({ timeout: 8_000 });
    // Final — not live
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 8_000 });
  });

  // ---------------------------------------------------------------------------
  // Not found (404)
  // ---------------------------------------------------------------------------
  test('404 response renders "Workflow run not found" empty state', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({ status: 404, json: { error: 'not found' } }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.getByText('Workflow run not found')).toBeVisible({ timeout: 8_000 });
    // Back link is present
    await expect(page.getByRole('link', { name: '← Back to workflow runs' }).first()).toBeVisible({
      timeout: 8_000,
    });
  });

  // ---------------------------------------------------------------------------
  // Load failure (non-404) — error state with manual retry + auto-retry hint
  // ---------------------------------------------------------------------------
  test('500 response renders error state with a Retry button and auto-retry hint', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({ status: 500, json: { error: 'database unavailable' } }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.getByText(/Failed to load workflow run: database unavailable/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(/Retrying automatically/i)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 8_000 });
    // The "not found" empty state must NOT be shown for a non-404 failure.
    await expect(page.getByText('Workflow run not found')).toHaveCount(0);
  });

  test('clicking Retry after a transient load failure recovers and shows the run detail', async ({ page }) => {
    await stubShellRoutes(page);
    // First request fails; every subsequent request (manual retry) succeeds.
    let served = 0;
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) => {
      served += 1;
      if (served === 1) {
        route.fulfill({ status: 500, json: { error: 'transient blip' } });
        return;
      }
      route.fulfill({
        json: {
          run: makeRun('completed'),
          steps: [makeStep('s1', 'fetch-context', 'completed')],
        } satisfies RunDetail,
      });
    });

    await page.goto(`/workflow-runs/${RUN_ID}`);

    // Error state appears for the first failed load.
    await expect(page.getByText(/Failed to load workflow run: transient blip/i)).toBeVisible({
      timeout: 8_000,
    });

    // Manual Retry re-fetches and the now-successful response renders the detail.
    await page.getByRole('button', { name: 'Retry' }).click();

    await expect(page.locator('[aria-label="status completed"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 8_000 });
    // Error state is gone once data loads.
    await expect(page.getByText(/Failed to load workflow run/i)).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // Transient refresh failure — prior snapshot stays, warning callout appears,
  // then clears on recovery. Distinct from the full-page load-error state which
  // only renders when there is no data yet.
  // ---------------------------------------------------------------------------
  test('live run keeps the prior snapshot and surfaces a "Failed to refresh" warning when a poll fails, then clears it on recovery', async ({
    page,
  }) => {
    await stubShellRoutes(page);
    // Poll 1: running. Poll 2: transient 503 (data already loaded). Poll 3+: completed.
    let served = 0;
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) => {
      served += 1;
      if (served === 2) {
        route.fulfill({ status: 503, json: { error: 'database hiccup' } });
        return;
      }
      route.fulfill({
        json:
          served === 1
            ? ({
                run: makeRun('running'),
                steps: [makeStep('s1', 'run-review', 'running')],
              } satisfies RunDetail)
            : ({
                run: makeRun('completed'),
                steps: [makeStep('s1', 'run-review', 'completed')],
              } satisfies RunDetail),
      });
    });

    await page.goto(`/workflow-runs/${RUN_ID}`);

    // Initial running snapshot loads cleanly.
    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });

    // Poll 2 (~5s) fails: the inline warning appears while the prior snapshot stays put.
    await expect(page.getByText(/Failed to refresh: database hiccup/i)).toBeVisible({ timeout: 12_000 });
    // The full-page load-error state must NOT replace the detail — stale data is still shown.
    await expect(page.getByText(/Failed to load workflow run/i)).toHaveCount(0);
    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible();
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible();

    // Poll 3 recovers: the warning clears and the run reaches its final snapshot.
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status completed"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/Failed to refresh/i)).toHaveCount(0);
  });

  test('live run keeps the prior snapshot when a refresh returns 404, then recovers to the final snapshot', async ({
    page,
  }) => {
    await stubShellRoutes(page);
    let served = 0;
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) => {
      served += 1;
      if (served === 2) {
        route.fulfill({ status: 404, json: { error: 'not found' } });
        return;
      }
      route.fulfill({
        json:
          served === 1
            ? ({
                run: makeRun('running'),
                steps: [makeStep('s1', 'run-review', 'running')],
              } satisfies RunDetail)
            : served === 3
              ? ({
                  run: makeRun('running'),
                  steps: [makeStep('s1', 'run-review', 'running')],
                } satisfies RunDetail)
              : ({
                run: makeRun('completed'),
                steps: [makeStep('s1', 'run-review', 'completed')],
              } satisfies RunDetail),
      });
    });

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });

    await expect(page.getByText(/Failed to refresh: workflow run not found/i)).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText(/Workflow run not found/i)).toHaveCount(0);
    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible();
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible();

    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 18_000 });
    await expect(page.locator('[aria-label="status completed"]').first()).toBeVisible({
      timeout: 18_000,
    });
    await expect(page.getByText(/Failed to refresh/i)).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // Cancelled run
  // ---------------------------------------------------------------------------
  test('cancelled run shows cancelled badge and "final snapshot" label', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: {
          run: makeRun('cancelled'),
          steps: [
            makeStep('s1', 'fetch-context', 'completed'),
            makeStep('s2', 'run-review', 'cancelled', { completedAt: null, durationMs: null }),
          ],
        } satisfies RunDetail,
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.locator('[aria-label="status cancelled"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 8_000 });
    // Attention panel for the cancelled step
    await expect(page.getByText('needs attention')).toBeVisible({ timeout: 8_000 });
    await expect(visibleStepAttentionLink(page, /cancelled before completion/i)).toBeVisible({
      timeout: 8_000,
    });
  });

  test('live run that finishes with a direct cancelled exit code shows a cancelled final snapshot after poll', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunning
          ? ({
              run: makeRun('running'),
              steps: [makeStep('s1', 'run-release', 'running')],
            } satisfies RunDetail)
          : ({
              run: makeRun('completed', {
                output: {
                  exitCode: -3,
                  detail: 'release was cancelled by the workflow after it started',
                },
              }),
              steps: [
                makeStep('s1', 'run-release', 'completed', {
                  output: {
                    exitCode: -3,
                    detail: 'release was cancelled by the workflow after it started',
                  },
                }),
              ],
            } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('final snapshot')).toHaveCount(0);

    serveRunning = false;

    const stepRowLocator = stepRow(page, 's1');
    await expect(page.locator('[aria-label="status cancelled"]').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(stepRowLocator.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(
      page.getByText('release was cancelled by the workflow after it started').first(),
    ).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0);
  });

  test('live run ending with a completed parent and non-zero step output clears running badges and surfaces the step issue', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunning
          ? ({
              run: makeRun('running'),
              steps: [makeStep('s1', 'run-push', 'running')],
            } satisfies RunDetail)
          : ({
              run: makeRun('completed', {
                output: {
                  waited: {
                    job: {
                      exitCode: 1,
                      detail: 'Push failed: remote rejected the update',
                    },
                  },
                },
              }),
              steps: [
                makeStep('s1', 'run-push', 'completed', {
                  output: {
                    exitCode: 1,
                    detail: 'Push failed: remote rejected the update',
                  },
                }),
              ],
            } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    const stepRowLocator = stepRow(page, 's1');
    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(stepRowLocator.getByLabel('status running')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });

    serveRunning = false;

    await expect(page.locator('[aria-label="status completed"]').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(stepRowLocator.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0);
    await expect(page.getByText('Push failed: remote rejected the update').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(visibleStepAttentionLink(page, /run push/i)).toBeVisible({ timeout: 12_000 });
    await expect(visibleStepAttentionLink(page, /exit 1: Push failed: remote rejected the update/i)).toBeVisible({
      timeout: 12_000,
    });
  });

  // ---------------------------------------------------------------------------
  // Attention panel — failed step with error string
  // ---------------------------------------------------------------------------
  test('attention panel surfaces failed step name and truncated first error line', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: {
          run: makeRun('failed', { error: 'step failed' }),
          steps: [
            makeStep('s1', 'prepare-env', 'completed'),
            makeStep('s2', 'deploy-contracts', 'failed', {
              error: 'deployment error: out of gas\n  at Contract.deploy (contracts.ts:42)',
            }),
          ],
        } satisfies RunDetail,
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.getByText('needs attention')).toBeVisible({ timeout: 8_000 });
    // Step name visible in the attention panel
    await expect(visibleStepAttentionLink(page, /deploy contracts/i)).toBeVisible({
      timeout: 8_000,
    });
    // First line of the error (truncated at newline)
    await expect(visibleStepAttentionLink(page, /deployment error: out of gas/i)).toBeVisible({
      timeout: 8_000,
    });
  });

  test('attention panel keeps multiple terminal step issues independently navigable after live run finishes', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunning
          ? ({
              run: makeRun('running'),
              steps: [
                makeStep('s1', 'prepare-env', 'completed'),
                makeStep('s2', 'deploy-contracts', 'running'),
                makeStep('s3', 'push-release', 'pending', {
                  startedAt: null,
                  completedAt: null,
                  durationMs: null,
                }),
              ],
            } satisfies RunDetail)
          : ({
              run: makeRun('failed', { error: 'release stopped after multiple terminal step issues' }),
              steps: [
                makeStep('s1', 'prepare-env', 'completed'),
                makeStep('s2', 'deploy-contracts', 'failed', {
                  error: 'deployment error: missing API token\n  at deploy.ts:42',
                }),
                makeStep('s3', 'push-release', 'cancelled', {
                  completedAt: null,
                  durationMs: null,
                  error: null,
                }),
              ],
            } satisfies RunDetail),
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    const failedRow = stepRow(page, 's2');
    const cancelledRow = stepRow(page, 's3');
    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({ timeout: 8_000 });
    await expect(failedRow.getByLabel('status running')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('needs attention')).toHaveCount(0);

    serveRunning = false;

    await expect(page.locator('[aria-label="status failed"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('[aria-label="status running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('needs attention')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('2 steps')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/failed\s*1/i).first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/cancelled\s*1/i).first()).toBeVisible({ timeout: 12_000 });

    const failedAttention = visibleStepAttentionLink(page, /deployment error: missing API token/i);
    const cancelledAttention = visibleStepAttentionLink(page, /cancelled before completion/i);
    await expect(failedAttention.getByLabel('status failed')).toBeVisible({ timeout: 12_000 });
    await expect(cancelledAttention.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(failedRow).toHaveClass(/bg-status-error\/10/);
    await expect(cancelledRow).toHaveClass(/bg-status-error\/10/);

    await cancelledAttention.click();

    await expect.poll(() => new URL(page.url()).hash, { timeout: 8_000 }).toBe(
      '#workflow-step-desktop-s3',
    );
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // No steps — shows empty steps section
  // ---------------------------------------------------------------------------
  test('run with no steps shows "No steps recorded" empty state in steps section', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route(`**/api/workflow-runs/${RUN_ID}`, (route: Route) =>
      route.fulfill({
        json: {
          run: makeRun('completed'),
          steps: [],
        } satisfies RunDetail,
      }),
    );

    await page.goto(`/workflow-runs/${RUN_ID}`);

    await expect(page.getByText('No steps recorded')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('[aria-label="status completed"]').first()).toBeVisible({ timeout: 8_000 });
  });
});
