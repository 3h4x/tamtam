import { test, expect, Route } from '@playwright/test';

// E2E coverage for the release pipeline strip on the Terminal tab.
// We mock /api/projects, /api/jobs, /api/projects/by-project/<name>/config,
// /api/agents and /api/streaming/<jobId> so scenarios are reproducible
// without running actual test/review/push jobs.

type Job = {
  id: string;
  project: string;
  kind: string;
  status: 'running' | 'done';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  verdict?: string;
  session_id?: string;
};

type Scenario = {
  changes: number;
  reviewed: boolean;
  unpushed: number;
  jobs: Job[];
  testCommand?: string;
  autoPushEnabled?: boolean;
};

async function mockScenario(page: import('@playwright/test').Page, scenario: Scenario) {
  const project = 'demoproj';

  await page.route('**/api/projects', (route: Route) => {
    route.fulfill({
      json: {
        tasks: [{
          project,
          path: '/tmp/demoproj',
          github: null,
          priority: null,
          changes: scenario.changes,
          reviewed: scenario.reviewed,
          unpushed: scenario.unpushed,
          last_run_ago: '5m ago',
          release_tag: 'v1.0.0',
        }],
      },
    });
  });

  await page.route('**/api/jobs?project=**', (route: Route) => {
    route.fulfill({ json: { jobs: scenario.jobs } });
  });

  await page.route(`**/api/projects/by-project/${project}/config`, (route: Route) => {
    route.fulfill({
      json: {
        project,
        test_command: '',
        detected_test_command: scenario.testCommand ?? '',
        effective_test_command: scenario.testCommand ?? '',
        test_cron_enabled: false,
        test_cron_schedule: '',
        auto_push_enabled: !!scenario.autoPushEnabled,
      },
    });
  });

  await page.route(`**/api/projects/by-project/${project}/action`, (route: Route) => {
    route.fulfill({ json: { actions: [] } });
  });

  await page.route(`**/api/agents?project=${project}`, (route: Route) => {
    route.fulfill({ json: { agents: [] } });
  });

  // Prevent SSE hang if the terminal tries to stream anything.
  await page.route('**/api/streaming/**', (route: Route) => {
    route.fulfill({ status: 204, body: '' });
  });

  return project;
}

test.describe('Release pipeline strip', () => {
  test('renders all stages: test → review → commit → push', async ({ page }) => {
    const project = await mockScenario(page, {
      changes: 3,
      reviewed: false,
      unpushed: 0,
      testCommand: 'pnpm test',
      autoPushEnabled: false,
      jobs: [
        {
          id: `${'demoproj'}-test-1`, project: 'demoproj', kind: 'test',
          status: 'done', exit_code: 0,
          started_at: Date.now() / 1000 - 60, finished_at: Date.now() / 1000 - 30,
        },
      ],
    });
    await page.goto(`/project/${project}/terminal`);
    // Pipeline strip should list test, review, commit, push in order.
    const strip = page.locator('text=/test.*→.*review.*→.*commit.*→.*push/i').first();
    await expect(strip).toBeVisible();
  });

  test('LGTM verdict with clean tree marks review done', async ({ page }) => {
    const now = Date.now() / 1000;
    const project = await mockScenario(page, {
      changes: 0,
      reviewed: true,
      unpushed: 0,
      testCommand: 'pnpm test',
      jobs: [
        {
          id: 'demoproj-review-lgtm', project: 'demoproj', kind: 'review',
          status: 'done', exit_code: 0, verdict: 'LGTM',
          started_at: now - 60, finished_at: now - 30,
          session_id: 'sess-lgtm',
        },
      ],
    });
    await page.goto(`/project/${project}/terminal`);
    // The review step should carry an "LGTM" state — look for the pipeline
    // review chip followed by a done glyph (✓) nearby.
    const reviewStep = page.getByTitle(/LGTM/i);
    await expect(reviewStep.first()).toBeVisible();
  });

  test('NEEDS ATTENTION verdict marks review as warning', async ({ page }) => {
    const now = Date.now() / 1000;
    const project = await mockScenario(page, {
      changes: 5,
      reviewed: false,
      unpushed: 0,
      testCommand: 'pnpm test',
      jobs: [
        {
          id: 'demoproj-review-na', project: 'demoproj', kind: 'review',
          status: 'done', exit_code: 0, verdict: 'NEEDS ATTENTION',
          started_at: now - 60, finished_at: now - 30,
          session_id: 'sess-na',
        },
      ],
    });
    await page.goto(`/project/${project}/terminal`);
    const reviewStep = page.getByTitle(/NEEDS ATTENTION/i);
    await expect(reviewStep.first()).toBeVisible();
  });

  test('clicking a done review step opens its terminal session', async ({ page }) => {
    const now = Date.now() / 1000;
    const project = await mockScenario(page, {
      changes: 0,
      reviewed: true,
      unpushed: 0,
      testCommand: 'pnpm test',
      jobs: [
        {
          id: 'demoproj-review-view', project: 'demoproj', kind: 'review',
          status: 'done', exit_code: 0, verdict: 'LGTM',
          started_at: now - 60, finished_at: now - 30,
          session_id: 'sess-view',
        },
      ],
    });
    await page.goto(`/project/${project}/terminal`);
    const reviewStep = page.getByTitle(/LGTM/i).first();
    await reviewStep.click();
    await expect(page).toHaveURL(new RegExp(`/project/${project}/terminal/sess-view`));
  });

  test('Release button disabled when nothing to release', async ({ page }) => {
    const project = await mockScenario(page, {
      changes: 0,
      reviewed: true,
      unpushed: 0,
      jobs: [],
    });
    await page.goto(`/project/${project}`);
    const btn = page.getByRole('button', { name: /Release/ });
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
  });
});
