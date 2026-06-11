import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'agents-stats-ui';
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

test.describe('Overview scheduled agents stats', () => {
  test('renders aggregate, disabled, error, and skipped states from mocked lifecycle data', async ({ page }) => {
    await stubOverviewShell(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({
        json: {
          internal: {
            entries: [
              {
                agentId: 'agent-review',
                project: PROJECT,
                name: 'review-agent',
                schedule: '2h',
                enabled: true,
                nextFireMs: NOW + 3_600_000,
                lastFireMs: NOW - 3_600_000,
                fireCount: 4,
                errorCount: 1,
                lastError: 'provider quota exhausted',
                skippedCount: 0,
                lastSkippedReason: null,
                lastJobMs: NOW - 900_000,
              },
              {
                agentId: 'agent-docs',
                project: PROJECT,
                name: 'docs-agent',
                schedule: '24h',
                enabled: false,
                nextFireMs: 0,
                lastFireMs: null,
                fireCount: 2,
                errorCount: 0,
                lastError: null,
                skippedCount: 3,
                lastSkippedReason: 'jobs paused',
                lastJobMs: null,
              },
              {
                agentId: 'foreign',
                project: 'other-project',
                name: 'foreign-agent',
                schedule: '1h',
                enabled: true,
                nextFireMs: NOW + 60_000,
                lastFireMs: null,
                fireCount: 99,
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
    await page.route(
      (url) => url.pathname === '/api/agents/stats' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            agents: [
              {
                name: 'review-agent',
                runs: 4,
                finishedRuns: 4,
                successfulRuns: 3,
                avgDurationMs: 73_000,
                totalDurationMs: 292_000,
                inputTokens: 12_000,
                outputTokens: 3_000,
                cacheReadTokens: 80_000,
                cacheCreateTokens: 2_000,
                costUsd: 0.42,
                modifiedFilesCount: 11,
                reviewFixesTriggered: 7,
              },
            ],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    const panel = page.locator('section').filter({ hasText: 'Scheduled agents' }).first();
    await expect(panel.getByText('Next:')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('review-agent').first()).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('docs-agent')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('foreign-agent')).toHaveCount(0);

    await expect(panel.getByText('4 total runs')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('97.0k tok').first()).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('$0.42').first()).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('11 files touched').first()).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('7 fixes triggered')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('75% success')).toBeVisible({ timeout: 8_000 });

    await expect(panel.getByText('disabled')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('errors 1')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('last error: provider quota exhausted')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('skipped 3')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('skipped: jobs paused')).toBeVisible({ timeout: 8_000 });
  });

  test('shows the empty state when scheduler health has no project entries', async ({ page }) => {
    await stubOverviewShell(page);
    await page.route('**/api/agents/scheduler-health', (route: Route) =>
      route.fulfill({ json: { internal: { entries: [] } } }),
    );
    await page.route(
      (url) => url.pathname === '/api/agents/stats' && url.searchParams.get('project') === PROJECT,
      (route: Route) => route.fulfill({ json: { agents: [] } }),
    );

    await page.goto(`/project/${PROJECT}`);

    const panel = page.locator('section').filter({ hasText: 'No scheduled agents' }).first();
    await expect(panel.getByText('No scheduled agents')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByRole('button', { name: 'Open Agents tab' })).toBeVisible({ timeout: 8_000 });
  });
});
