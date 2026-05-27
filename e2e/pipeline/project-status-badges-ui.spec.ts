import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Project status badge UI tests — verifies that the four running-state badges
// on the home page project table render correctly based on runtime data:
//   • "releasing" — release job running ≤30 min
//   • "stuck"     — release job running >30 min (animate-pulse error badge)
//   • "agent running" — agent: job running, no release
//   • "running"   — generic non-release, non-agent job running
//
// All tests use the 1338 test server; no real pipeline execution.

const PROJECT = 'status-badge-ui';
const now = () => Math.floor(Date.now() / 1000);

function makeTask(project: string) {
  return {
    id: `${project}-1`,
    project,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${project}`,
    fires_at: '',
    sync: true,
    changes: 3,
    unpushed: 0,
    reviewed: false,
    last_run: null,
    last_run_ago: null,
    last_run_duration_s: null,
    last_run_exit: null,
    release_tag: null,
    ci: null,
    ci_failed_url: null,
    github: null,
  };
}

function makeRuntime(project: string, overrides: Partial<{
  hasRunningRelease: boolean;
  runningCount: number;
  runningKinds: string[];
  runningAgentNames: string[];
  releaseStartedAt: number | null;
}> = {}): Record<string, object> {
  const { releaseStartedAt, ...fields } = overrides;
  const startedAt = releaseStartedAt ?? (now() - 60);
  return {
    [project]: {
      hasRunningReview: false,
      hasRunningTest: false,
      hasRunningRelease: fields.hasRunningRelease ?? false,
      hasRunningPipelineChild: false,
      runningCount: fields.runningCount ?? 0,
      runningKinds: fields.runningKinds ?? [],
      runningAgentNames: fields.runningAgentNames ?? [],
      latestVerdict: null,
      latestVerdictAt: null,
      lastActivityAt: startedAt,
      lastJob: fields.hasRunningRelease ? {
        id: `${project}-release-1`,
        kind: 'release',
        status: 'running',
        exitCode: null,
        startedAt,
        finishedAt: null,
        verdict: null,
      } : null,
    },
  };
}

async function stubCommonRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(PROJECT)], priorities: [], issueCounts: {} },
    }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/agents/scheduler-health', (route: Route) =>
    route.fulfill({ json: { internal: { entries: [], paused: false } } }),
  );
  await page.route('**/api/agents?fields=summary', (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

// -------------------------------------------------------------------------
// "releasing" badge — release running ≤30 min
// -------------------------------------------------------------------------
test('shows "releasing" badge when release is running and started recently', async ({ page }) => {
  await stubCommonRoutes(page);
  await page.route('**/api/projects/runtime', (route: Route) =>
    route.fulfill({
      json: {
        projects: makeRuntime(PROJECT, {
          hasRunningRelease: true,
          runningCount: 1,
          runningKinds: ['release'],
          releaseStartedAt: now() - 5 * 60, // 5 minutes ago
        }),
      },
    }),
  );

  await page.goto('/');

  // The releasing badge uses "releasing" text and warning color classes
  await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('releasing')).toBeVisible({ timeout: 5_000 });
  // Must NOT show "stuck" (not past 30 min threshold)
  await expect(page.getByText('stuck')).toHaveCount(0);
});

// -------------------------------------------------------------------------
// "stuck" badge — release running >30 min (pulsing error badge)
// -------------------------------------------------------------------------
test('shows "stuck" badge with animate-pulse when release has been running >30 min', async ({
  page,
}) => {
  await stubCommonRoutes(page);
  await page.route('**/api/projects/runtime', (route: Route) =>
    route.fulfill({
      json: {
        projects: makeRuntime(PROJECT, {
          hasRunningRelease: true,
          runningCount: 1,
          runningKinds: ['release'],
          releaseStartedAt: now() - 35 * 60, // 35 minutes ago → stuck
        }),
      },
    }),
  );

  await page.goto('/');

  await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });

  // "stuck" badge must be visible and carry animate-pulse class
  await expect(page.locator('span.animate-pulse').filter({ hasText: 'stuck' })).toBeVisible({
    timeout: 5_000,
  });
  // "releasing" must NOT appear — only "stuck" is shown
  await expect(page.getByText('releasing')).toHaveCount(0);
});

// -------------------------------------------------------------------------
// "agent running" badge — agent job running, no release
// -------------------------------------------------------------------------
test('shows "agent running" badge when an agent job is running and no release', async ({
  page,
}) => {
  await stubCommonRoutes(page);
  await page.route('**/api/projects/runtime', (route: Route) =>
    route.fulfill({
      json: {
        projects: makeRuntime(PROJECT, {
          hasRunningRelease: false,
          runningCount: 1,
          runningKinds: ['agent:improve'],
          runningAgentNames: ['improve'],
        }),
      },
    }),
  );

  await page.goto('/');

  await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });

  // Badge text is "agent running" (for a single agent)
  await expect(page.getByText('agent running')).toBeVisible({ timeout: 5_000 });
  // Must not show "releasing" or "stuck" since hasRunningRelease=false
  await expect(page.getByText('releasing')).toHaveCount(0);
  await expect(page.getByText('stuck')).toHaveCount(0);
});

// -------------------------------------------------------------------------
// Multiple agents — "N agents running" badge
// -------------------------------------------------------------------------
test('shows "N agents running" badge when multiple agent jobs are running', async ({ page }) => {
  await stubCommonRoutes(page);
  await page.route('**/api/projects/runtime', (route: Route) =>
    route.fulfill({
      json: {
        projects: makeRuntime(PROJECT, {
          hasRunningRelease: false,
          runningCount: 2,
          runningKinds: ['agent:improve', 'agent:test-gen'],
          runningAgentNames: ['improve', 'test-gen'],
        }),
      },
    }),
  );

  await page.goto('/');

  await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('2 agents running')).toBeVisible({ timeout: 5_000 });
});

// -------------------------------------------------------------------------
// Generic "running" badge — non-release, non-agent job
// -------------------------------------------------------------------------
test('shows generic "running" badge for non-release, non-agent jobs', async ({ page }) => {
  await stubCommonRoutes(page);
  await page.route('**/api/projects/runtime', (route: Route) =>
    route.fulfill({
      json: {
        projects: makeRuntime(PROJECT, {
          hasRunningRelease: false,
          runningCount: 1,
          runningKinds: ['review'],
          runningAgentNames: [],
        }),
      },
    }),
  );

  await page.goto('/');

  await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('running')).toBeVisible({ timeout: 5_000 });
  // Must not show the more specific badges
  await expect(page.getByText('releasing')).toHaveCount(0);
  await expect(page.getByText('stuck')).toHaveCount(0);
  await expect(page.getByText(/agent.*running/i)).toHaveCount(0);
});

// -------------------------------------------------------------------------
// No status badge when project is idle
// -------------------------------------------------------------------------
test('shows no running badge when project has no running jobs', async ({ page }) => {
  await stubCommonRoutes(page);
  await page.route('**/api/projects/runtime', (route: Route) =>
    route.fulfill({
      json: {
        projects: makeRuntime(PROJECT, {
          hasRunningRelease: false,
          runningCount: 0,
          runningKinds: [],
          runningAgentNames: [],
        }),
      },
    }),
  );

  await page.goto('/');

  await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('releasing')).toHaveCount(0);
  await expect(page.getByText('stuck')).toHaveCount(0);
  await expect(page.getByText('running')).toHaveCount(0);
  await expect(page.getByText(/agent.*running/i)).toHaveCount(0);
});
