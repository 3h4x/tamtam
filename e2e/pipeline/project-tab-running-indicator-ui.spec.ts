import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'project-tab-running-ui';
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

function makeJob(id: string, kind: string, status: 'running' | 'done', exitCode: number | null) {
  return {
    id,
    project: PROJECT,
    kind,
    status,
    exit_code: exitCode,
    started_at: now() - 60,
    finished_at: status === 'done' ? now() - 5 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    verdict: null,
    parent_job_id: null,
    parent_kind: null,
  };
}

async function stubProjectShellRoutes(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(PROJECT)], priorities: [], issueCounts: {} },
    }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) =>
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
  await page.route(
    `**/api/projects/by-project/${PROJECT}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/issues?summary=1`,
    (route: Route) =>
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
  await page.route(
    `**/api/projects/by-project/${PROJECT}/branch`,
    (route: Route) =>
      route.fulfill({
        json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 },
      }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/recommendations/summary', (route: Route) =>
    route.fulfill({ json: { openCount: 0 } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

test.describe('Project tab running indicator', () => {
  test('Terminal tab indicator clears after the last running job finishes', async ({ page }) => {
    let phase: 'running' | 'idle' = 'running';

    await stubProjectShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: phase === 'running' ? [makeJob('tab-review-live', 'review', 'running', null)] : [],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    const runningTab = page.getByRole('button', { name: 'Terminal, 1 running' });
    await expect(runningTab).toBeVisible({ timeout: 8_000 });
    await expect(runningTab.locator('span.animate-pulse[title="1 running"]')).toBeVisible();

    phase = 'idle';

    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: 'Terminal, 1 running' })).toHaveCount(0);
    await expect(page.locator('button[aria-label^="Terminal,"] span.animate-pulse')).toHaveCount(0);
  });

  test('Terminal tab indicator count updates while another job keeps running', async ({ page }) => {
    let phase: 'two-running' | 'one-running' = 'two-running';

    await stubProjectShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs =
          phase === 'two-running'
            ? [
                makeJob('tab-review-live', 'review', 'running', null),
                makeJob('tab-test-live', 'test', 'running', null),
              ]
            : [makeJob('tab-test-live', 'test', 'running', null)];

        route.fulfill({ json: { jobs, pendingReleaseProjects: [] } });
      },
    );

    await page.goto(`/project/${PROJECT}`);

    const twoRunningTab = page.getByRole('button', { name: 'Terminal, 2 running' });
    await expect(twoRunningTab).toBeVisible({ timeout: 8_000 });
    await expect(twoRunningTab.locator('span.animate-pulse[title="2 running"]')).toBeVisible();

    phase = 'one-running';

    const oneRunningTab = page.getByRole('button', { name: 'Terminal, 1 running' });
    await expect(oneRunningTab).toBeVisible({ timeout: 12_000 });
    await expect(oneRunningTab.locator('span.animate-pulse[title="1 running"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Terminal, 2 running' })).toHaveCount(0);
  });

  test('Terminal tab indicator clears when the running job fails', async ({ page }) => {
    let phase: 'running' | 'failed' = 'running';

    await stubProjectShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'tab-review-failed',
                'review',
                phase === 'running' ? 'running' : 'done',
                phase === 'running' ? null : 1,
              ),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    const runningTab = page.getByRole('button', { name: 'Terminal, 1 running' });
    await expect(runningTab).toBeVisible({ timeout: 8_000 });
    await expect(runningTab.locator('span.animate-pulse[title="1 running"]')).toBeVisible();

    phase = 'failed';

    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: 'Terminal, 1 running' })).toHaveCount(0);
    await expect(page.locator('button[aria-label^="Terminal,"] span.animate-pulse')).toHaveCount(0);
  });
});
