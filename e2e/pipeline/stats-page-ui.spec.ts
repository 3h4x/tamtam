import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Mocked-API UI tests for the /stats page.
// Verifies stat cards, project table, top-agents table, window switching, and empty state.
// No real pipeline execution — all API calls are intercepted.

const now = () => Math.floor(Date.now() / 1000);

const PRICING = {
  input: 3.0,
  output: 15.0,
  cacheWrite: 3.75,
  cacheRead: 0.3,
};

function makeUsageResponse(overrides: {
  projects?: Array<{
    project: string;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    totalTokens: number;
    costUsd: number;
    lastRunAt: number | null;
  }>;
  agents?: Array<{
    kind: string;
    runs: number;
    commitProducingRuns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    totalTokens: number;
    costUsd: number;
    avgPromptBytes: number | null;
    avgPromptTokens: number | null;
    promptSamples: number;
  }>;
  window?: string;
} = {}) {
  const projects = overrides.projects ?? [];
  const agents = overrides.agents ?? [];
  const totals = projects.reduce(
    (acc, r) => ({
      runs: acc.runs + r.runs,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreateTokens: acc.cacheCreateTokens + r.cacheCreateTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      costUsd: acc.costUsd + r.costUsd,
    }),
    {
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  );
  return {
    window: overrides.window ?? '24h',
    generatedAt: Date.now(),
    pricing: PRICING,
    totals,
    projects,
    agents,
  };
}

async function stubStatsRoutes(
  page: import('@playwright/test').Page,
  usageResponse: ReturnType<typeof makeUsageResponse>,
  opts: { ollamaOk?: boolean } = {},
): Promise<void> {
  await page.route('**/api/stats/usage**', (route: Route) =>
    route.fulfill({ json: usageResponse }),
  );
  await page.route('**/api/stats/ollama**', (route: Route) => {
    if (opts.ollamaOk) {
      route.fulfill({
        json: {
          status: 'ok',
          models: [],
          generatedAt: Date.now(),
          windowLabel: '24 hours',
        },
      });
    } else {
      route.fulfill({ status: 404, body: '' });
    }
  });
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: {
          jobs_paused: 'false',
          budget_warn_at_pct: '80',
          budget_block_at_pct: '95',
          budget_subscription_providers: null,
        },
        github_owner: '',
      },
    }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  // QuotaWidget fetches budget data
  await page.route('**/api/usage/quota**', (route: Route) =>
    route.fulfill({
      json: {
        gateEnabled: false,
        sevenDay: { utilization: 0, resetsAt: null, msUntilReset: null },
      },
    }),
  );
  // BridgeOverview fetches /api/stats/bridge and /api/stats/system
  await page.route('**/api/stats/bridge**', (route: Route) =>
    route.fulfill({
      json: {
        generatedAt: Date.now(),
        globalPace: {
          status: 'unknown',
          bindingProvider: null,
          bindingWindow: null,
          marginPct: null,
          projectedPct: null,
          providers: [],
        },
        throttle: null,
        projects: [],
        summary: {
          projects: 0,
          agentsEnabled: 0,
          shipping: 0,
          stuck: 0,
          agent_running: 0,
          error: 0,
          attention: 0,
          releasing: 0,
          paused: 0,
          active: 0,
          idle: 0,
          runningReleases: 0,
        },
      },
    }),
  );
  await page.route('**/api/stats/system**', (route: Route) =>
    route.fulfill({ json: { current: null, samples: [] } }),
  );
  await page.route('**/api/stats/usage-history**', (route: Route) =>
    route.fulfill({
      json: {
        generatedAt: Date.now(),
        hours: 24,
        series: [],
      },
    }),
  );
  // BridgeOverview fetches /api/projects/runtime
  await page.route('**/api/projects/runtime**', (route: Route) =>
    route.fulfill({ json: {} }),
  );
  await page.route('**/api/projects**', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
}

// ---------------------------------------------------------------------------
// Test 1: stat cards render with real data
// ---------------------------------------------------------------------------
test('stats page renders totals stat cards from API response', async ({ page }) => {
  const usage = makeUsageResponse({
    projects: [
      {
        project: 'alpha',
        runs: 42,
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cacheReadTokens: 500_000,
        cacheCreateTokens: 100_000,
        totalTokens: 1_800_000,
        costUsd: 4.50,
        lastRunAt: now() - 300,
      },
    ],
  });
  await stubStatsRoutes(page, usage);

  await page.goto('/stats');

  // Stat cards: "Runs" count
  await expect(page.getByText('42').first()).toBeVisible({ timeout: 8_000 });
  // Cost card
  await expect(page.getByText('$4.50').first()).toBeVisible({ timeout: 8_000 });
  // Total tokens (1.8M)
  await expect(page.getByText('1.80M').first()).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// Test 2: project appears in the sortable project table
// ---------------------------------------------------------------------------
test('stats page shows project row in table with cost and run count', async ({ page }) => {
  const usage = makeUsageResponse({
    projects: [
      {
        project: 'my-project',
        runs: 10,
        inputTokens: 500_000,
        outputTokens: 80_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalTokens: 580_000,
        costUsd: 2.70,
        lastRunAt: now() - 60,
      },
    ],
  });
  await stubStatsRoutes(page, usage);

  await page.goto('/stats');

  // Project name link
  await expect(page.getByRole('link', { name: 'my-project' })).toBeVisible({ timeout: 8_000 });
  // Run count
  await expect(page.getByText('10').first()).toBeVisible({ timeout: 8_000 });
  // Cost
  await expect(page.getByText('$2.70').first()).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// Test 3: empty state when no projects
// ---------------------------------------------------------------------------
test('stats page shows empty state when there are no projects in the window', async ({ page }) => {
  const usage = makeUsageResponse({ projects: [], agents: [] });
  await stubStatsRoutes(page, usage);

  await page.goto('/stats');

  await expect(
    page.getByText(/no usage data in the last/i).first(),
  ).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// Test 4: top agents table renders when agents are present
// ---------------------------------------------------------------------------
test('stats page shows top agents table when agent data is present', async ({ page }) => {
  const usage = makeUsageResponse({
    projects: [
      {
        project: 'proj',
        runs: 5,
        inputTokens: 100_000,
        outputTokens: 20_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalTokens: 120_000,
        costUsd: 0.60,
        lastRunAt: now() - 100,
      },
    ],
    agents: [
      {
        kind: 'review',
        runs: 5,
        commitProducingRuns: 0,
        inputTokens: 80_000,
        outputTokens: 15_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalTokens: 95_000,
        costUsd: 0.46,
        avgPromptBytes: 4096,
        avgPromptTokens: 1024,
        promptSamples: 5,
      },
    ],
  });
  await stubStatsRoutes(page, usage);

  await page.goto('/stats');

  // Table heading
  await expect(
    page.getByText('Top agents / pipeline steps').first(),
  ).toBeVisible({ timeout: 8_000 });
  // Kind column value
  await expect(page.getByText('review').first()).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// Test 5: top agents table absent when no agent data
// ---------------------------------------------------------------------------
test('stats page does not show top agents table when agents list is empty', async ({ page }) => {
  const usage = makeUsageResponse({
    projects: [
      {
        project: 'proj-only',
        runs: 3,
        inputTokens: 50_000,
        outputTokens: 10_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalTokens: 60_000,
        costUsd: 0.30,
        lastRunAt: now() - 200,
      },
    ],
    agents: [],
  });
  await stubStatsRoutes(page, usage);

  await page.goto('/stats');

  await expect(page.getByRole('link', { name: 'proj-only' })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('Top agents / pipeline steps')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 6: window selector switches the fetch window
// ---------------------------------------------------------------------------
test('stats page re-fetches with a new window when the selector is changed', async ({ page }) => {
  let lastWindowParam = '24h';

  await stubStatsRoutes(page, makeUsageResponse({ window: '24h' }));

  await page.route((url) => url.pathname === '/api/stats/usage', (route: Route) => {
    const url = new URL(route.request().url());
    lastWindowParam = url.searchParams.get('window') ?? '24h';
    route.fulfill({
      json: makeUsageResponse({ window: lastWindowParam }),
    });
  });

  await page.goto('/stats');

  // Page loads with 24h window.
  await expect(page.getByRole('button', { name: '24h' })).toBeVisible({ timeout: 8_000 });
  expect(lastWindowParam).toBe('24h');

  // Click the "7d" segment.
  const segmentBtn = page.getByRole('button', { name: '7d' });
  await expect(segmentBtn).toBeVisible({ timeout: 8_000 });
  await segmentBtn.click();

  // The page should re-fetch with window=7d.
  await expect
    .poll(() => lastWindowParam, { timeout: 8_000 })
    .toBe('7d');
});

// ---------------------------------------------------------------------------
// Test 7: table sort by project name
// ---------------------------------------------------------------------------
test('stats page project table sorts by project name on header click', async ({ page }) => {
  const usage = makeUsageResponse({
    projects: [
      {
        project: 'zebra',
        runs: 1,
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalTokens: 12_000,
        costUsd: 0.05,
        lastRunAt: now() - 600,
      },
      {
        project: 'alpha',
        runs: 5,
        inputTokens: 100_000,
        outputTokens: 20_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalTokens: 120_000,
        costUsd: 0.60,
        lastRunAt: now() - 60,
      },
    ],
  });
  await stubStatsRoutes(page, usage);

  await page.goto('/stats');

  // Verify both projects appear
  const alphaLink = page.getByRole('link', { name: 'alpha' });
  const zebraLink = page.getByRole('link', { name: 'zebra' });
  await expect(alphaLink).toBeVisible({ timeout: 8_000 });
  await expect(zebraLink).toBeVisible({ timeout: 8_000 });

  // Click "Project" sort header to sort ascending
  const projectHeader = page.getByRole('columnheader', { name: /project/i });
  await projectHeader.click();

  // After sort asc: alpha should appear before zebra in the DOM.
  const alphaIndex = await alphaLink.evaluate((el: Element) => {
    const row = el.closest('tr');
    return row ? Array.from(row.parentElement?.children ?? []).indexOf(row) : -1;
  });
  const zebraIndex = await zebraLink.evaluate((el: Element) => {
    const row = el.closest('tr');
    return row ? Array.from(row.parentElement?.children ?? []).indexOf(row) : -1;
  });
  expect(alphaIndex).toBeLessThan(zebraIndex);
});

// ---------------------------------------------------------------------------
// Test 8: error state when API call fails
// ---------------------------------------------------------------------------
test('stats page shows error state and retry button when the API fails', async ({ page }) => {
  await page.route('**/api/stats/usage**', (route: Route) =>
    route.fulfill({ status: 500, body: 'Internal Server Error' }),
  );
  await page.route('**/api/stats/ollama**', (route: Route) =>
    route.fulfill({ status: 404, body: '' }),
  );
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
      json: {
        gateEnabled: false,
        sevenDay: { utilization: 0, resetsAt: null, msUntilReset: null },
      },
    }),
  );
  await page.route('**/api/stats/bridge**', (route: Route) =>
    route.fulfill({
      json: { projects: [], pace: null, providers: [], generatedAt: Date.now() },
    }),
  );
  await page.route('**/api/stats/system**', (route: Route) =>
    route.fulfill({ json: { current: null, samples: [] } }),
  );
  await page.route('**/api/projects/runtime**', (route: Route) =>
    route.fulfill({ json: {} }),
  );
  await page.route('**/api/projects**', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );

  await page.goto('/stats');

  // Error state renders with a retry button
  await expect(page.getByText(/failed to load usage stats/i).first()).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByRole('button', { name: /retry/i }).first()).toBeVisible({
    timeout: 8_000,
  });
});
