import { test, expect } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';

// WorkflowRunDetail UI tests — verify running/completed/failed/cancelled/404
// edge cases using mocked API. All tests use the port 1338 test server; no
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
