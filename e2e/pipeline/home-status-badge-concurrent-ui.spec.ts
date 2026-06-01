import { test, expect } from '@playwright/test';
import type { Route, Page } from '@playwright/test';

// Home page concurrent project status badges — verifies that two different
// projects releasing at the same time each render their own independent badge
// on `/`, and that one finishing on the next `/api/projects/runtime` poll
// clears only that project's badge while the other keeps spinning.
//
// ProjectTablePage polls /api/projects/runtime every 30s. Each transition test
// budgets one poll cycle (~30s) plus render overhead.
//
// Pure UI test: page.route() controls the runtime response; no Claude/git/gh
// shim involvement.

const PROJECT_A = 'home-concurrent-a';
const PROJECT_B = 'home-concurrent-b';
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

function releasingEntry(project: string) {
  const startedAt = now() - 60;
  return {
    [project]: {
      hasRunningReview: false,
      hasRunningTest: false,
      hasRunningRelease: true,
      hasRunningPipelineChild: false,
      runningCount: 1,
      runningKinds: ['release'],
      runningAgentNames: [],
      latestVerdict: null,
      latestVerdictAt: null,
      lastActivityAt: startedAt,
      lastJob: {
        id: `${project}-release-1`,
        kind: 'release',
        status: 'running',
        exitCode: null,
        startedAt,
        finishedAt: null,
        verdict: null,
      },
    },
  };
}

function idleEntry(project: string) {
  return {
    [project]: {
      hasRunningReview: false,
      hasRunningTest: false,
      hasRunningRelease: false,
      hasRunningPipelineChild: false,
      runningCount: 0,
      runningKinds: [],
      runningAgentNames: [],
      latestVerdict: null,
      latestVerdictAt: null,
      lastActivityAt: now() - 60,
      lastJob: null,
    },
  };
}

async function stubCommonRoutes(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [makeTask(PROJECT_A), makeTask(PROJECT_B)],
        priorities: [],
        issueCounts: {},
      },
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

const TRANSITION_TIMEOUT = 60_000;

function rowFor(page: Page, project: string) {
  return page.getByRole('row').filter({ hasText: project });
}

test.describe('Home status badge concurrent transitions', () => {
  test('two projects release together, then one finishing clears only its own badge', async ({
    page,
  }) => {
    test.setTimeout(TRANSITION_TIMEOUT);
    // phase 1: both releasing. phase 2: A finished, B still releasing.
    let phase: 'both' | 'a-done' = 'both';

    await stubCommonRoutes(page);
    await page.route('**/api/projects/runtime', (route: Route) => {
      const projects = {
        ...(phase === 'both' ? releasingEntry(PROJECT_A) : idleEntry(PROJECT_A)),
        ...releasingEntry(PROJECT_B),
      };
      route.fulfill({ json: { projects } });
    });

    await page.goto('/');

    const rowA = rowFor(page, PROJECT_A);
    const rowB = rowFor(page, PROJECT_B);
    await expect(rowA).toBeVisible({ timeout: 8_000 });
    await expect(rowB).toBeVisible({ timeout: 8_000 });

    // Both projects independently show their own "releasing" badge.
    await expect(rowA.getByText('releasing')).toBeVisible({ timeout: 8_000 });
    await expect(rowB.getByText('releasing')).toBeVisible({ timeout: 8_000 });

    // Project A's release finishes; next poll must clear A's badge only.
    phase = 'a-done';
    await expect(rowA.getByText('releasing')).toHaveCount(0, { timeout: 40_000 });
    // B keeps spinning — independent state, no cross-project clobbering.
    await expect(rowB.getByText('releasing')).toBeVisible();
  });
});
