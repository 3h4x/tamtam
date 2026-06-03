import { test, expect } from '@playwright/test';
import type { Route, Page } from '@playwright/test';

// Mocked-API UI tests for the global /pipeline metrics page (PipelinePage).
// Verifies summary cards, verdict distribution, window switching, empty state,
// and the error/retry path. No real pipeline execution — all API calls are
// intercepted via page.route().

function makePipelineResponse(overrides: {
  window?: string;
  verdicts?: Partial<{
    lgtm: number;
    needsAttention: number;
    doNotShip: number;
    parseFailed: number;
    prunedMissingVerdict: number;
    total: number;
  }>;
  fixLoop?: Partial<{ total: number; converged: number; hitCap: number; avgIterations: number }>;
  pipelineSuccess?: Partial<{ succeeded: number; failed: number; total: number; rate: number }>;
  projects?: Array<{
    project: string;
    releases: number;
    successRate: number;
    reviewCount: number;
    lgtmRate: number;
    fixIterationsAvg: number;
    medianReleaseDurationMs: number | null;
  }>;
} = {}) {
  return {
    window: overrides.window ?? '24h',
    generatedAt: Date.now(),
    project: null,
    verdicts: {
      lgtm: 0,
      needsAttention: 0,
      doNotShip: 0,
      parseFailed: 0,
      prunedMissingVerdict: 0,
      total: 0,
      ...overrides.verdicts,
    },
    fixLoop: {
      total: 0,
      converged: 0,
      hitCap: 0,
      avgIterations: 0,
      ...overrides.fixLoop,
    },
    pipelineSuccess: {
      succeeded: 0,
      failed: 0,
      total: 0,
      rate: 0,
      ...overrides.pipelineSuccess,
    },
    stepDurations: {},
    mttr: null,
    projects: overrides.projects ?? [],
    configSnapshot: {
      verdictRules: 'default',
      commitStyle: 'conventional',
      maxStepIterations: null,
      maxPushFixAttempts: 2,
      stepWindowSeconds: 3600,
    },
  };
}

// Stub the surrounding app chrome (top nav / quota widget / notifications) so
// the page renders in isolation regardless of real backend state.
async function stubChrome(page: Page): Promise<void> {
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: 'false', budget_warn_at_pct: '80', budget_block_at_pct: '95' },
        github_owner: '',
      },
    }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/usage/quota**', (route: Route) =>
    route.fulfill({
      json: { gateEnabled: false, sevenDay: { utilization: 0, resetsAt: null, msUntilReset: null } },
    }),
  );
}

// ---------------------------------------------------------------------------
// Test 1: summary cards render from API response
// ---------------------------------------------------------------------------
test('pipeline page renders summary cards from API response', async ({ page }) => {
  await stubChrome(page);
  await page.route('**/api/stats/pipeline**', (route: Route) =>
    route.fulfill({
      json: makePipelineResponse({
        verdicts: { lgtm: 8, needsAttention: 1, doNotShip: 1, total: 10 },
        pipelineSuccess: { succeeded: 9, failed: 1, total: 10, rate: 0.9 },
        fixLoop: { total: 4, converged: 3, hitCap: 1, avgIterations: 2 },
      }),
    }),
  );

  await page.goto('/pipeline');

  await expect(page.getByText('Pipeline Metrics')).toBeVisible({ timeout: 8_000 });
  // Pipeline success rate card: 9/10 releases => 90%
  await expect(page.getByText('9/10 releases')).toBeVisible({ timeout: 8_000 });
  // Review LGTM rate card: 8/10 reviews
  await expect(page.getByText('8/10 reviews')).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// Test 2: empty state — no releases / reviews shows em-dash placeholders
// ---------------------------------------------------------------------------
test('pipeline page shows no-data placeholders when the window is empty', async ({ page }) => {
  await stubChrome(page);
  await page.route('**/api/stats/pipeline**', (route: Route) =>
    route.fulfill({ json: makePipelineResponse() }),
  );

  await page.goto('/pipeline');

  await expect(page.getByText('Pipeline Metrics')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('No releases').first()).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('No reviews').first()).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// Test 3: window selector re-fetches with the new window param
// ---------------------------------------------------------------------------
test('pipeline page re-fetches with a new window when the selector changes', async ({ page }) => {
  await stubChrome(page);
  let lastWindowParam = '24h';
  await page.route((url) => url.pathname === '/api/stats/pipeline', (route: Route) => {
    const url = new URL(route.request().url());
    lastWindowParam = url.searchParams.get('window') ?? '24h';
    route.fulfill({ json: makePipelineResponse({ window: lastWindowParam }) });
  });

  await page.goto('/pipeline');

  await expect(page.getByText('Pipeline Metrics')).toBeVisible({ timeout: 8_000 });
  await expect.poll(() => lastWindowParam, { timeout: 8_000 }).toBe('24h');

  const segment = page.getByRole('button', { name: '7d', exact: true });
  await expect(segment).toBeVisible({ timeout: 8_000 });
  await segment.click();

  await expect.poll(() => lastWindowParam, { timeout: 8_000 }).toBe('7d');
});

// ---------------------------------------------------------------------------
// Test 4: error state + retry recovers
// ---------------------------------------------------------------------------
test('pipeline page shows error state and recovers on retry', async ({ page }) => {
  await stubChrome(page);
  let failNext = true;
  await page.route((url) => url.pathname === '/api/stats/pipeline', (route: Route) => {
    if (failNext) {
      failNext = false;
      route.fulfill({ status: 500, body: 'Internal Server Error' });
      return;
    }
    route.fulfill({
      json: makePipelineResponse({
        pipelineSuccess: { succeeded: 5, failed: 0, total: 5, rate: 1 },
      }),
    });
  });

  await page.goto('/pipeline');

  await expect(page.getByText(/failed to load pipeline metrics/i)).toBeVisible({ timeout: 8_000 });
  const retry = page.getByRole('button', { name: /retry/i }).first();
  await expect(retry).toBeVisible({ timeout: 8_000 });
  await retry.click();

  // After retry the real metrics surface renders.
  await expect(page.getByText('Pipeline Metrics')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('5/5 releases')).toBeVisible({ timeout: 8_000 });
});
