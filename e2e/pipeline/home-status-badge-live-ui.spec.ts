import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Home page project status badge live transitions — verifies that the
// project-row badges on `/` flip on the next `/api/projects/runtime` poll
// without a page reload.
//
// ProjectTablePage polls /api/projects/runtime every 30s (see ProjectTablePage.tsx).
// Each test therefore allows up to ~35s for the next poll cycle to land,
// then asserts the new badge text and the absence of the prior one.
//
// Pure UI test: page.route() controls the runtime response; no Claude/git/gh
// shim involvement.

const PROJECT = 'home-badge-live-ui';
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
    changes: 0,
    unpushed: 0,
    reviewed: true,
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

type RuntimeShape = {
  hasRunningRelease?: boolean;
  runningCount?: number;
  runningKinds?: string[];
  runningAgentNames?: string[];
  releaseStartedAt?: number | null;
};

function makeRuntime(project: string, overrides: RuntimeShape = {}): Record<string, object> {
  const { releaseStartedAt, ...fields } = overrides;
  const startedAt = releaseStartedAt ?? (now() - 60);
  const hasRunningRelease = fields.hasRunningRelease ?? false;
  return {
    [project]: {
      hasRunningReview: false,
      hasRunningTest: false,
      hasRunningRelease,
      hasRunningPipelineChild: false,
      runningCount: fields.runningCount ?? 0,
      runningKinds: fields.runningKinds ?? [],
      runningAgentNames: fields.runningAgentNames ?? [],
      latestVerdict: null,
      latestVerdictAt: null,
      lastActivityAt: startedAt,
      lastJob: hasRunningRelease
        ? {
            id: `${project}-release-1`,
            kind: 'release',
            status: 'running',
            exitCode: null,
            startedAt,
            finishedAt: null,
            verdict: null,
          }
        : null,
    },
  };
}

function rowFor(page: import('@playwright/test').Page, project: string) {
  return page.getByRole('row').filter({ hasText: project });
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

// Each transition test budgets roughly 5s for the initial render plus one
// 30s runtime poll cycle plus rendering overhead. 60s gives a safe margin.
const TRANSITION_TIMEOUT = 60_000;

// ─── Test 1: idle → releasing ────────────────────────────────────────────────
test.describe('Home status badge live transitions', () => {
  test('flips idle → releasing on next runtime poll', async ({ page }) => {
    test.setTimeout(TRANSITION_TIMEOUT);
    let phase: 'idle' | 'releasing' = 'idle';

    await stubCommonRoutes(page);
    await page.route('**/api/projects/runtime', (route: Route) => {
      const body =
        phase === 'idle'
          ? makeRuntime(PROJECT)
          : makeRuntime(PROJECT, {
              hasRunningRelease: true,
              runningCount: 1,
              runningKinds: ['release'],
              releaseStartedAt: now() - 60,
            });
      route.fulfill({ json: { projects: body } });
    });

    await page.goto('/');
    await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
    // Confirm starting state: no running badges.
    await expect(page.getByText('releasing')).toHaveCount(0);
    await expect(page.locator('span.animate-pulse').filter({ hasText: 'stuck' })).toHaveCount(0);

    // Flip the mock; the next 30s poll should pick it up.
    phase = 'releasing';
    await expect(page.getByText('releasing')).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('span.animate-pulse').filter({ hasText: 'stuck' })).toHaveCount(0);
  });

  // ─── Test 2: releasing → stuck ─────────────────────────────────────────────
  test('flips releasing → stuck after release age crosses 30 min threshold', async ({ page }) => {
    test.setTimeout(TRANSITION_TIMEOUT);
    let phase: 'fresh' | 'stuck' = 'fresh';

    await stubCommonRoutes(page);
    await page.route('**/api/projects/runtime', (route: Route) => {
      const body =
        phase === 'fresh'
          ? makeRuntime(PROJECT, {
              hasRunningRelease: true,
              runningCount: 1,
              runningKinds: ['release'],
              releaseStartedAt: now() - 5 * 60, // 5m old
            })
          : makeRuntime(PROJECT, {
              hasRunningRelease: true,
              runningCount: 1,
              runningKinds: ['release'],
              releaseStartedAt: now() - 35 * 60, // 35m old → stuck
            });
      route.fulfill({ json: { projects: body } });
    });

    await page.goto('/');
    await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('releasing')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('span.animate-pulse').filter({ hasText: 'stuck' })).toHaveCount(0);

    phase = 'stuck';
    await expect(
      page.locator('span.animate-pulse').filter({ hasText: 'stuck' }),
    ).toBeVisible({ timeout: 40_000 });
    // The "releasing" badge must give way to "stuck" — only one is shown at a time.
    await expect(page.getByText('releasing')).toHaveCount(0);
  });

  // ─── Test 3: releasing → idle ─────────────────────────────────────────────
  test('clears the "releasing" badge after the release finishes on next runtime poll', async ({
    page,
  }) => {
    test.setTimeout(TRANSITION_TIMEOUT);
    let phase: 'releasing' | 'idle' = 'releasing';

    await stubCommonRoutes(page);
    await page.route('**/api/projects/runtime', (route: Route) => {
      const body =
        phase === 'releasing'
          ? makeRuntime(PROJECT, {
              hasRunningRelease: true,
              runningCount: 1,
              runningKinds: ['release'],
              releaseStartedAt: now() - 60,
            })
          : makeRuntime(PROJECT);
      route.fulfill({ json: { projects: body } });
    });

    await page.goto('/');
    await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('releasing')).toBeVisible({ timeout: 8_000 });

    // Release completes — next poll must clear the badge.
    phase = 'idle';
    await expect(page.getByText('releasing')).toHaveCount(0, { timeout: 40_000 });
    await expect(page.locator('span.animate-pulse').filter({ hasText: 'stuck' })).toHaveCount(0);
  });

  // ─── Test 4: agent running → idle ──────────────────────────────────────────
  test('clears the "agent running" badge after the agent finishes', async ({ page }) => {
    test.setTimeout(TRANSITION_TIMEOUT);
    let phase: 'running' | 'idle' = 'running';

    await stubCommonRoutes(page);
    await page.route('**/api/projects/runtime', (route: Route) => {
      const body =
        phase === 'running'
          ? makeRuntime(PROJECT, {
              hasRunningRelease: false,
              runningCount: 1,
              runningKinds: ['agent:improve'],
              runningAgentNames: ['improve'],
            })
          : makeRuntime(PROJECT);
      route.fulfill({ json: { projects: body } });
    });

    await page.goto('/');
    await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('agent running')).toBeVisible({ timeout: 8_000 });

    phase = 'idle';
    await expect(page.getByText('agent running')).toHaveCount(0, { timeout: 40_000 });
    await expect(page.getByText('releasing')).toHaveCount(0);
    await expect(page.locator('span.animate-pulse').filter({ hasText: 'stuck' })).toHaveCount(0);
  });

  test('clears the generic "running" badge after a non-release job finishes', async ({ page }) => {
    test.setTimeout(TRANSITION_TIMEOUT);
    let phase: 'running' | 'idle' = 'running';

    await stubCommonRoutes(page);
    await page.route('**/api/projects/runtime', (route: Route) => {
      const body =
        phase === 'running'
          ? makeRuntime(PROJECT, {
              hasRunningRelease: false,
              runningCount: 1,
              runningKinds: ['review'],
              runningAgentNames: [],
            })
          : makeRuntime(PROJECT);
      route.fulfill({ json: { projects: body } });
    });

    await page.goto('/');
    const row = rowFor(page, PROJECT);
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.getByText('running', { exact: true })).toBeVisible({ timeout: 8_000 });

    phase = 'idle';
    await expect(row.getByText('running', { exact: true })).toHaveCount(0, { timeout: 40_000 });
    await expect(row.getByText('releasing')).toHaveCount(0);
    await expect(row.locator('span.animate-pulse').filter({ hasText: 'stuck' })).toHaveCount(0);
  });

  test('updates the agent badge count when one of two running agents finishes', async ({ page }) => {
    test.setTimeout(TRANSITION_TIMEOUT);
    let phase: 'two-running' | 'one-running' = 'two-running';

    await stubCommonRoutes(page);
    await page.route('**/api/projects/runtime', (route: Route) => {
      const body =
        phase === 'two-running'
          ? makeRuntime(PROJECT, {
              hasRunningRelease: false,
              runningCount: 2,
              runningKinds: ['agent:improve', 'agent:test-gen'],
              runningAgentNames: ['improve', 'test-gen'],
            })
          : makeRuntime(PROJECT, {
              hasRunningRelease: false,
              runningCount: 1,
              runningKinds: ['agent:improve'],
              runningAgentNames: ['improve'],
            });
      route.fulfill({ json: { projects: body } });
    });

    await page.goto('/');
    await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('2 agents running')).toBeVisible({ timeout: 8_000 });

    phase = 'one-running';
    await expect(page.getByText('agent running')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText('2 agents running')).toHaveCount(0);
    await expect(page.getByText('releasing')).toHaveCount(0);
  });

  test('falls back from "releasing" to "agent running" when the release finishes but an agent keeps running', async ({
    page,
  }) => {
    test.setTimeout(TRANSITION_TIMEOUT);
    let phase: 'release-and-agent' | 'agent-only' = 'release-and-agent';

    await stubCommonRoutes(page);
    await page.route('**/api/projects/runtime', (route: Route) => {
      const body =
        phase === 'release-and-agent'
          ? makeRuntime(PROJECT, {
              hasRunningRelease: true,
              runningCount: 2,
              runningKinds: ['release', 'agent:improve'],
              runningAgentNames: ['improve'],
              releaseStartedAt: now() - 60,
            })
          : makeRuntime(PROJECT, {
              hasRunningRelease: false,
              runningCount: 1,
              runningKinds: ['agent:improve'],
              runningAgentNames: ['improve'],
            });
      route.fulfill({ json: { projects: body } });
    });

    await page.goto('/');
    await expect(page.getByText(PROJECT)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('releasing')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('agent running')).toHaveCount(0);

    phase = 'agent-only';

    await expect(page.getByText('agent running')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText('releasing')).toHaveCount(0, { timeout: 40_000 });
    await expect(page.locator('span.animate-pulse').filter({ hasText: 'stuck' })).toHaveCount(0);
  });
});
