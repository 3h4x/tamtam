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
  release_id?: string | null;
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
  test('renders only the linked jobs that actually ran in the active chain', async ({ page }) => {
    const now = Date.now() / 1000;
    const project = await mockScenario(page, {
      changes: 3,
      reviewed: false,
      unpushed: 0,
      testCommand: 'pnpm test',
      autoPushEnabled: false,
      jobs: [
        {
          id: 'demoproj-manual-test', project: 'demoproj', kind: 'test',
          status: 'done', exit_code: 0,
          started_at: now - 180, finished_at: now - 150,
        },
        {
          id: 'demoproj-review-1', project: 'demoproj', kind: 'review',
          status: 'done', exit_code: 0, verdict: 'LGTM', release_id: 'rel-1',
          started_at: now - 90, finished_at: now - 60,
        },
        {
          id: 'demoproj-push-1', project: 'demoproj', kind: 'push',
          status: 'running', exit_code: null, release_id: 'rel-1',
          started_at: now - 10, finished_at: null,
        },
      ],
    });
    await page.goto(`/project/${project}/terminal`);
    await expect(page.getByTitle(/LGTM/i).first()).toBeVisible();
    await expect(page.getByTitle(/push in progress/i).first()).toBeVisible();
    await expect(page.getByText('commit')).toHaveCount(0);
  });

  test('LGTM verdict stays visible while a later linked step is running', async ({ page }) => {
    const now = Date.now() / 1000;
    const project = await mockScenario(page, {
      changes: 0,
      reviewed: true,
      unpushed: 0,
      testCommand: 'pnpm test',
      jobs: [
        {
          id: 'demoproj-review-lgtm', project: 'demoproj', kind: 'review',
          status: 'done', exit_code: 0, verdict: 'LGTM', release_id: 'rel-2',
          started_at: now - 60, finished_at: now - 30,
          session_id: 'sess-lgtm',
        },
        {
          id: 'demoproj-push-running', project: 'demoproj', kind: 'push',
          status: 'running', exit_code: null, release_id: 'rel-2',
          started_at: now - 5, finished_at: null,
        },
      ],
    });
    await page.goto(`/project/${project}/terminal`);
    const reviewStep = page.getByTitle(/LGTM/i);
    await expect(reviewStep.first()).toBeVisible();
  });

  test('NEEDS ATTENTION verdict stays visible while a linked fix is running', async ({ page }) => {
    const now = Date.now() / 1000;
    const project = await mockScenario(page, {
      changes: 5,
      reviewed: false,
      unpushed: 0,
      testCommand: 'pnpm test',
      jobs: [
        {
          id: 'demoproj-review-na', project: 'demoproj', kind: 'review',
          status: 'done', exit_code: 0, verdict: 'NEEDS ATTENTION', release_id: 'rel-3',
          started_at: now - 60, finished_at: now - 30,
          session_id: 'sess-na',
        },
        {
          id: 'demoproj-fix-running', project: 'demoproj', kind: 'fix',
          status: 'running', exit_code: null, release_id: 'rel-3',
          started_at: now - 5, finished_at: null,
        },
      ],
    });
    await page.goto(`/project/${project}/terminal`);
    const reviewStep = page.getByTitle(/NEEDS ATTENTION/i);
    await expect(reviewStep.first()).toBeVisible();
  });

  test('clicking a done review step opens its terminal session while the strip is visible', async ({ page }) => {
    const now = Date.now() / 1000;
    const project = await mockScenario(page, {
      changes: 0,
      reviewed: true,
      unpushed: 0,
      testCommand: 'pnpm test',
      jobs: [
        {
          id: 'demoproj-review-view', project: 'demoproj', kind: 'review',
          status: 'done', exit_code: 0, verdict: 'LGTM', release_id: 'rel-4',
          started_at: now - 60, finished_at: now - 30,
          session_id: 'sess-view',
        },
        {
          id: 'demoproj-push-view', project: 'demoproj', kind: 'push',
          status: 'running', exit_code: null, release_id: 'rel-4',
          started_at: now - 5, finished_at: null,
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
