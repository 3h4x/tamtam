import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Settings → CLI tab e2e UI tests.
//
// The unit tests (cli-tab.test.tsx) stub fetch to always fail for quota
// requests, so they never exercise the live "blocked" quota pill that appears
// when /api/usage/quota returns high utilization. These tests fill that gap:
//   1. The "blocked" pill appears when a provider's 5-hour utilization meets or
//      exceeds the configured block threshold AND block is enabled.
//   2. The "blocked" pill is absent at the same utilization when block is off.
//
// All API calls are mocked — no real pipeline execution and no real quota data.

function makeSettings(overrides: Record<string, string> = {}) {
  return {
    workspace_path: '',
    github_owner: '',
    jobs_paused: 'false',
    cli_enabled_providers: 'claude',
    cli_bin_claude: '',
    cli_bin_codex: '',
    cli_bin_gemini: '',
    cli_bin_lmstudio: '',
    cli_bin_deepagents: '',
    cli_deepagents_backend: 'lmstudio',
    cli_deepagents_base_url: '',
    cli_default_model_claude: 'normal',
    cli_default_model_codex: 'normal',
    cli_default_model_gemini: 'normal',
    cli_default_model_lmstudio: 'normal',
    cli_default_model_deepagents: 'normal',
    lmstudio_model: '',
    default_model: 'fast',
    permission_mode: 'auto',
    base_prompt: '',
    budget_block_runs_enabled: 'false',
    budget_block_on_weekly_pace_enabled: 'true',
    budget_block_at_pct: '95',
    budget_warn_at_pct: '80',
    ...overrides,
  };
}

// Stub every route the settings shell needs. The quota route defaults to 503
// (unavailable) so no badge renders unless the individual test overrides it.
async function stubShell(
  page: import('@playwright/test').Page,
  overrides: Record<string, string> = {},
): Promise<void> {
  await page.route('**/api/settings', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { settings: makeSettings(overrides) } });
    }
    return route.continue();
  });
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/agents**', (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  // Default: quota unavailable → no badge rendered.
  await page.route('**/api/usage/quota**', (route: Route) =>
    route.fulfill({ status: 503, json: { error: 'quota service unavailable' } }),
  );
}

// Build a valid QuotaSnapshot payload that loadQuotaSnapshot treats as available.
// utilization is a 0–100 percentage value.
function makeQuotaSnapshot(fiveHourPct: number, sevenDayPct = Math.round(fiveHourPct * 0.7)) {
  return {
    fiveHour: { utilization: fiveHourPct, resetsAt: null, msUntilReset: null },
    sevenDay: { utilization: sevenDayPct, resetsAt: null, msUntilReset: null },
    fetchedAt: 1_700_000_000_000,
    stale: false,
  };
}

test.describe('Settings → CLI tab quota badge', () => {
  test('"blocked" pill appears when Claude 5h utilization meets the block threshold and block is on', async ({
    page,
  }) => {
    await stubShell(page, {
      budget_block_runs_enabled: 'true',
      budget_block_at_pct: '95',
      cli_enabled_providers: 'claude',
    });

    // Override the default 503 stub with high-utilization quota for Claude.
    // Later-registered routes take precedence in Playwright, so this wins.
    await page.route(
      (url) =>
        url.pathname === '/api/usage/quota' &&
        url.searchParams.get('provider') === 'claude',
      (route: Route) => route.fulfill({ json: makeQuotaSnapshot(97) }),
    );

    await page.goto('/settings/cli');
    await expect(page.getByRole('heading', { name: 'Enabled CLIs' })).toBeVisible({
      timeout: 8_000,
    });

    // The "blocked" pill renders because 97 % >= blockAt (95) and block is enabled.
    await expect(page.getByText('blocked', { exact: true })).toBeVisible({ timeout: 8_000 });

    // The utilization percentage is also shown in the quota line.
    await expect(page.getByText(/5h 97%/)).toBeVisible({ timeout: 8_000 });
  });

  test('"blocked" pill is absent when block is disabled even at high utilization', async ({
    page,
  }) => {
    await stubShell(page, {
      budget_block_runs_enabled: 'false',
      budget_block_at_pct: '95',
      cli_enabled_providers: 'claude',
    });

    // Same high utilization but block gate is off → blockedNow stays false.
    await page.route(
      (url) =>
        url.pathname === '/api/usage/quota' &&
        url.searchParams.get('provider') === 'claude',
      (route: Route) => route.fulfill({ json: makeQuotaSnapshot(97) }),
    );

    await page.goto('/settings/cli');
    await expect(page.getByRole('heading', { name: 'Enabled CLIs' })).toBeVisible({
      timeout: 8_000,
    });

    // Utilization is displayed but the "blocked" pill must not appear.
    await expect(page.getByText(/5h 97%/)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('blocked', { exact: true })).toHaveCount(0);
  });
});
