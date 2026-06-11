import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'pipeline-stats-empty-ui';
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

// Pipeline stats for a project that has never produced a release in the
// window: zero totals everywhere, null mttr, no per-step durations. Exercises
// every empty-state branch in PipelineStatsPanel.
function makeEmptyPipelineStats(window_ = '30d') {
  return {
    window: window_,
    generatedAt: NOW,
    project: PROJECT,
    pipelineSuccess: { succeeded: 0, failed: 0, total: 0, rate: 0 },
    fixLoop: { total: 0, converged: 0, hitCap: 0, avgIterations: 0 },
    stepDurations: {},
    mttr: null,
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

test.describe('Overview pipeline stats panel — loading + empty branches', () => {
  test('renders the skeleton until the first stats load resolves, then shows the panel', async ({ page }) => {
    await stubOverviewShell(page);

    // Hold the initial pipeline-stats request open so the loading branch
    // (loading && !data) stays on screen long enough to assert.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === '/api/stats/pipeline' && url.searchParams.get('project') === PROJECT,
      async (route: Route) => {
        await gate;
        await route.fulfill({ json: makeEmptyPipelineStats() });
      },
    );

    await page.goto(`/project/${PROJECT}`);

    // Skeleton placeholders are visible; the real header text is not yet rendered.
    await expect(page.locator('.skeleton').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Pipeline performance')).toHaveCount(0);

    // Resolve the held request — the panel header should now replace the skeleton.
    release();

    await expect(page.getByText('Pipeline performance')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('.skeleton')).toHaveCount(0);
  });

  test('shows empty-state copy for a project with no releases in the window', async ({ page }) => {
    await stubOverviewShell(page);
    await page.route(
      (url) => url.pathname === '/api/stats/pipeline' && url.searchParams.get('project') === PROJECT,
      (route: Route) => route.fulfill({ json: makeEmptyPipelineStats(new URL(route.request().url()).searchParams.get('window') ?? '30d') }),
    );

    await page.goto(`/project/${PROJECT}`);

    const panel = page.locator('section').filter({ hasText: 'Pipeline performance' }).first();
    await expect(panel.getByText('avg successful release')).toBeVisible({ timeout: 8_000 });

    // Each metric card falls back to its empty-state detail line.
    await expect(panel.getByText('No successful releases yet')).toBeVisible();
    await expect(panel.getByText('No successful release cost recorded in this window')).toBeVisible();
    await expect(panel.getByText('No completed releases in this window')).toBeVisible();
    await expect(panel.getByText('No test runs in this window')).toBeVisible();
    await expect(panel.getByText('No recovery loops observed')).toBeVisible();

    // With no per-step durations, every StepCard shows a "0 runs" pill.
    await expect(panel.getByText('0 runs').first()).toBeVisible();

    // No stale-snapshot warning on a clean empty load.
    await expect(panel.getByText('Showing last successful snapshot.')).toHaveCount(0);
  });
});
