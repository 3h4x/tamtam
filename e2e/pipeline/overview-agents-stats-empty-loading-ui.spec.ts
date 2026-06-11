import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'agents-stats-empty-ui';
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

function makePipelineStats() {
  return {
    window: '30d',
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
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/stats/pipeline' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: makePipelineStats() }),
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
        memory: { sampled: 0, truncatedCount: 0, truncationRate: 0, avgRawChars: null, maxRawChars: 0 },
        prereq: { withPrereq: 0, withoutPrereq: 0 },
      },
    }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents/stats' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
}

test.describe('Overview scheduled agents — loading and no-upcoming-fires', () => {
  test('shows the skeleton while scheduler health is loading, then the panel', async ({ page }) => {
    await stubOverviewShell(page);

    let releaseHealth!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    await page.route('**/api/agents/scheduler-health', async (route: Route) => {
      await gate;
      await route.fulfill({
        json: {
          internal: {
            entries: [
              {
                agentId: 'agent-1',
                project: PROJECT,
                name: 'review-agent',
                schedule: '2h',
                enabled: true,
                nextFireMs: NOW + 3_600_000,
                lastFireMs: NOW - 3_600_000,
                fireCount: 1,
                errorCount: 0,
                lastError: null,
                skippedCount: 0,
                lastSkippedReason: null,
                lastJobMs: null,
              },
            ],
          },
        },
      });
    });

    await page.goto(`/project/${PROJECT}`);

    // While health is held, the AgentsStats section renders only skeleton bars —
    // the loaded header text must not be present yet.
    const skeletonSection = page.locator('section', { has: page.locator('.skeleton') }).first();
    await expect(skeletonSection.locator('.skeleton').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Scheduled agents')).toHaveCount(0);

    releaseHealth();

    await expect(page.getByText('Scheduled agents')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('review-agent').first()).toBeVisible({ timeout: 8_000 });
  });

  test('shows "No upcoming fires." and hides the aggregate when no enabled entry has a next fire', async ({ page }) => {
    await stubOverviewShell(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({
        json: {
          internal: {
            entries: [
              {
                agentId: 'agent-disabled',
                project: PROJECT,
                name: 'paused-agent',
                schedule: '24h',
                enabled: false,
                nextFireMs: 0,
                lastFireMs: null,
                fireCount: 0,
                errorCount: 0,
                lastError: null,
                skippedCount: 0,
                lastSkippedReason: null,
                lastJobMs: null,
              },
              {
                agentId: 'agent-noschedule',
                project: PROJECT,
                name: 'idle-agent',
                schedule: '1h',
                enabled: true,
                nextFireMs: 0,
                lastFireMs: null,
                fireCount: 0,
                errorCount: 0,
                lastError: null,
                skippedCount: 0,
                lastSkippedReason: null,
                lastJobMs: null,
              },
            ],
          },
        },
      }),
    );

    await page.goto(`/project/${PROJECT}`);

    const panel = page.locator('section').filter({ hasText: 'Scheduled agents' }).first();
    await expect(panel.getByText('No upcoming fires.')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('Next:')).toHaveCount(0);
    // No finished runs in stats → totalRuns is 0 → the aggregate line stays hidden.
    await expect(panel.getByText('total runs')).toHaveCount(0);
    // Both project entries still list, even with no upcoming fire.
    await expect(panel.getByText('paused-agent')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('idle-agent')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('disabled')).toBeVisible({ timeout: 8_000 });
  });
});
