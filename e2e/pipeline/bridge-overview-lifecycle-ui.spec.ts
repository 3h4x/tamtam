import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'bridge-live-ui';
const now = () => Math.floor(Date.now() / 1000);

function makeUsageResponse() {
  return {
    window: '24h',
    generatedAt: Date.now(),
    pricing: {
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    },
    totals: {
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    projects: [],
    agents: [],
  };
}

function makeBridgeResponse(status: 'releasing' | 'shipping') {
  return {
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
    projects: [
      {
        project: PROJECT,
        agents: 1,
        status,
        lastAgentAt: now() - 120,
        lastPushAt: status === 'shipping' ? now() - 15 : null,
        lastPushOk: status === 'shipping' ? true : null,
        lastReleaseAt: now() - 60,
        lastReleaseOk: null,
      },
    ],
    summary: {
      projects: 1,
      agentsEnabled: 1,
      shipping: status === 'shipping' ? 1 : 0,
      stuck: 0,
      agent_running: 0,
      error: 0,
      attention: 0,
      releasing: status === 'releasing' ? 1 : 0,
      paused: 0,
      active: 0,
      idle: 0,
      runningReleases: status === 'releasing' ? 1 : 0,
    },
  };
}

async function stubStatsShellRoutes(page: Page): Promise<void> {
  await page.route('**/api/stats/usage**', (route: Route) =>
    route.fulfill({ json: makeUsageResponse() }),
  );
  await page.route('**/api/stats/usage-history**', (route: Route) =>
    route.fulfill({ json: { generatedAt: Date.now(), hours: 24, series: [] } }),
  );
  await page.route('**/api/stats/ollama**', (route: Route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await page.route('**/api/stats/system**', (route: Route) =>
    route.fulfill({ json: { current: null, samples: [] } }),
  );
  await page.route('**/api/usage/quota**', (route: Route) =>
    route.fulfill({
      json: {
        gateEnabled: false,
        sevenDay: { utilization: 0, resetsAt: null, msUntilReset: null },
      },
    }),
  );
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
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/recommendations/summary', (route: Route) =>
    route.fulfill({ json: { openCount: 0 } }),
  );
  await page.route('**/api/projects/runtime**', (route: Route) =>
    route.fulfill({ json: { projects: {} } }),
  );
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
}

test.describe('Bridge overview lifecycle transitions', () => {
  test('project chip clears releasing pulse and shows shipping on bridge poll', async ({ page }) => {
    test.setTimeout(55_000);
    let phase: 'releasing' | 'shipping' = 'releasing';

    await stubStatsShellRoutes(page);
    await page.route('**/api/stats/bridge**', (route: Route) =>
      route.fulfill({ json: makeBridgeResponse(phase) }),
    );

    await page.goto('/stats');

    const releasingChip = page.locator(`a[title^="${PROJECT} · releasing"]`);
    await expect(releasingChip).toBeVisible({ timeout: 8_000 });
    await expect(releasingChip.locator('span').first()).toHaveClass(/animate-pulse/);
    await expect(page.getByText('1 releasing')).toBeVisible();
    await expect(page.getByText('1 shipping')).toHaveCount(0);

    phase = 'shipping';

    const shippingChip = page.locator(`a[title^="${PROJECT} · shipping"]`);
    await expect(shippingChip).toBeVisible({ timeout: 40_000 });
    await expect(shippingChip.locator('span').first()).not.toHaveClass(/animate-pulse/);
    await expect(page.getByText('1 shipping')).toBeVisible();
    await expect(page.getByText('1 releasing')).toHaveCount(0);
  });
});
