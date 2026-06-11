import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'pipeline-stats-ui';
const NOW = new Date('2026-06-11T10:00:00Z').getTime();

function makeTask() {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
    paused: false,
    path: `/tmp/${PROJECT}`,
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

function makePipelineStats(window_ = '30d') {
  return {
    window: window_,
    generatedAt: NOW,
    project: PROJECT,
    pipelineSuccess: { succeeded: 2, failed: 1, total: 3, rate: 2 / 3 },
    fixLoop: { total: 1, converged: 1, hitCap: 0, avgIterations: 1 },
    stepDurations: {
      test: { avg: 20_000, median: 18_000, p95: 30_000, count: 3 },
      review: { avg: 42_000, median: 40_000, p95: 55_000, count: 3 },
    },
    mttr: { avg: 90_000, median: 80_000, p95: 120_000, count: 2, avgCostUsd: 5.5 },
    projects: [],
    configSnapshot: {
      verdictRules: 'default',
      commitStyle: 'conventional',
      maxStepIterations: null,
      maxPushFixAttempts: 2,
      stepWindowSeconds: 3600,
    },
  };
}

async function stubOverviewShell(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({
      json: {
        project: PROJECT,
        test_command: '',
        detected_test_command: '',
        effective_test_command: '',
        test_cron_enabled: false,
        test_cron_schedule: '',
        auto_push_enabled: false,
        auto_commit_enabled: false,
        auto_pr_merge_enabled: false,
        post_merge_watch_minutes: 0,
        auto_revert_enabled: false,
        pr_workflow_enabled: false,
        release_after_run: false,
        tests_disabled: false,
        review_disabled: false,
        issue_auto_branch: false,
      },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues?summary=1`, (route: Route) =>
    route.fulfill({
      json: {
        repo: '',
        issueCount: 0,
        prCount: 0,
        openPrBranches: [],
        error: null,
        cached: true,
        cachedAt: NOW,
      },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/agents/scheduler-health', (route: Route) =>
    route.fulfill({ json: { internal: { entries: [] } } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents/stats' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/prompt-insights**`, (route: Route) =>
    route.fulfill({
      json: {
        windowDays: 7,
        agentJobCount: 0,
        promptBytes: null,
        retrieval: {
          sampled: 0,
          queried: 0,
          attached: 0,
          queriedRate: 0,
          attachRate: 0,
          avgTopScore: null,
          avgAcceptedChunks: null,
          reasons: {},
        },
        memory: {
          sampled: 0,
          truncatedCount: 0,
          truncationRate: 0,
          avgRawChars: null,
          maxRawChars: 0,
        },
        prereq: { withPrereq: 0, withoutPrereq: 0 },
      },
    }),
  );
}

test.describe('Overview pipeline stats panel', () => {
  test('shows a hard error when the initial pipeline stats load fails', async ({ page }) => {
    await stubOverviewShell(page);
    await page.route(
      (url) => url.pathname === '/api/stats/pipeline' && url.searchParams.get('project') === PROJECT,
      (route: Route) => route.fulfill({ status: 500, body: 'Internal Server Error' }),
    );

    await page.goto(`/project/${PROJECT}`);

    const panel = page.locator('section').filter({ hasText: 'Pipeline performance' }).first();
    await expect(panel.getByText('Failed to load pipeline stats')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('avg successful release')).toHaveCount(0);
  });

  test('keeps the last pipeline stats snapshot visible when a window refresh fails', async ({ page }) => {
    await stubOverviewShell(page);
    await page.route(
      (url) => url.pathname === '/api/stats/pipeline' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const window_ = new URL(route.request().url()).searchParams.get('window') ?? '30d';
        if (window_ === '7d') {
          route.fulfill({ status: 500, body: 'Internal Server Error' });
          return;
        }
        route.fulfill({ json: makePipelineStats(window_) });
      },
    );

    await page.goto(`/project/${PROJECT}`);

    const panel = page.locator('section').filter({ hasText: 'Pipeline performance' }).first();
    await expect(panel.getByText('avg successful release')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('1m 30s')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('2/3 finished successfully')).toBeVisible({ timeout: 8_000 });

    await panel.getByRole('button', { name: '7d', exact: true }).click();

    await expect(
      panel.getByText('Failed to load pipeline stats. Showing last successful snapshot.'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('avg successful release')).toBeVisible();
    await expect(panel.getByText('2/3 finished successfully')).toBeVisible();
    await expect(panel.getByRole('button', { name: '7d', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});
