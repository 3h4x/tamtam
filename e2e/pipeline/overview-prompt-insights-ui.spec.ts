import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'prompt-insights-ui';

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

/**
 * Stub every endpoint the project overview shell fetches so the page renders
 * deterministically without the real server, then leave `prompt-insights`
 * for each test to script its own lifecycle/empty/loaded response.
 */
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
        cachedAt: Date.now(),
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
}

function loadedInsights() {
  return {
    windowDays: 7,
    agentJobCount: 9,
    promptBytes: { avg: 2048, p50: 1900, p95: 4096, max: 8192 },
    retrieval: {
      sampled: 9,
      queried: 8,
      attached: 6,
      queriedRate: 0.89,
      attachRate: 0.75,
      avgTopScore: 0.842,
      avgAcceptedChunks: 3.4,
      reasons: { 'keyword-match': 5, 'doc-overlap': 2 },
    },
    memory: {
      sampled: 9,
      truncatedCount: 3,
      truncationRate: 0.3333,
      avgRawChars: 1450,
      maxRawChars: 3200,
    },
    prereq: { withPrereq: 4, withoutPrereq: 5 },
  };
}

test.describe('Overview prompt insights panel', () => {
  test('renders loaded stats from the prompt-insights payload', async ({ page }) => {
    await stubOverviewShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/prompt-insights**`, (route: Route) =>
      route.fulfill({ json: loadedInsights() }),
    );

    await page.goto(`/project/${PROJECT}`);

    const panel = page.locator('section').filter({ hasText: 'Prompt insights' }).first();
    await expect(panel.getByRole('heading', { name: 'Prompt insights' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(panel.getByText('last 7 days · 9 agent runs')).toBeVisible({ timeout: 8_000 });
    // Avg prompt formatted from bytes; retrieval attach rate rounds 0.75 → 75%.
    await expect(panel.getByText('2.0 KB')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('75%')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('6/8 queried')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('0.842')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('keyword-match (5)')).toBeVisible({ timeout: 8_000 });
    // Memory truncation 3/9 → 33%; prereq coverage 4/(4+5).
    await expect(panel.getByText('33%')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('4/9')).toBeVisible({ timeout: 8_000 });
  });

  test('shows the empty state when there are no agent runs in the window', async ({ page }) => {
    await stubOverviewShell(page);
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

    await page.goto(`/project/${PROJECT}`);

    const panel = page.locator('section').filter({ hasText: 'Prompt insights' }).first();
    await expect(panel.getByText('No agent runs in the last 7 days yet.')).toBeVisible({
      timeout: 8_000,
    });
    // None of the loaded-state stat headers render in the empty branch.
    await expect(panel.getByText('Avg prompt')).toHaveCount(0);
  });

  test('shows the loading state then resolves to loaded stats without reload', async ({ page }) => {
    await stubOverviewShell(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/projects/by-project/${PROJECT}/prompt-insights**`, async (route: Route) => {
      await gate;
      await route.fulfill({ json: loadedInsights() });
    });

    await page.goto(`/project/${PROJECT}`);

    const panel = page.locator('section').filter({ hasText: 'Prompt insights' }).first();
    await expect(panel.getByText('Loading…')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('last 7 days · 9 agent runs')).toHaveCount(0);

    release();

    await expect(panel.getByText('last 7 days · 9 agent runs')).toBeVisible({ timeout: 8_000 });
    await expect(panel.getByText('Loading…')).toHaveCount(0);
  });
});
