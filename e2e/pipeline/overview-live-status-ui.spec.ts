import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'overview-live-ui';
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

function makeJob(
  id: string,
  kind: 'review' | 'test',
  status: 'running' | 'done',
  exitCode: number | null,
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
  };
}

async function stubOverviewRoutes(page: Page): Promise<void> {
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
    `**/api/projects/by-project/${PROJECT}/issues/summary`,
    (route: Route) =>
      route.fulfill({ json: { issueCount: 0, prCount: 0, openPrBranches: [] } }),
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
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

test.describe('Overview tab live status polling', () => {
  test('review card flips from running to LGTM and clears the active-work banner without reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              serveRunning
                ? makeJob('review-live', 'review', 'running', null)
                : makeJob('review-live', 'review', 'done', 0, {
                    verdict: 'LGTM',
                    session_id: 'sess-review-live',
                  }),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /review running/i }).first()).toBeVisible({
      timeout: 8_000,
    });

    serveRunning = false;

    await expect(page.getByText('1 running now')).not.toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /review LGTM/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /review running/i })).toHaveCount(0);
  });

  test('tests card flips from running to failed exit code and clears the active-work banner without reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              serveRunning
                ? makeJob('test-live', 'test', 'running', null)
                : makeJob('test-live', 'test', 'done', 1),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /tests running/i }).first()).toBeVisible({
      timeout: 8_000,
    });

    serveRunning = false;

    await expect(page.getByText('1 running now')).not.toBeVisible({ timeout: 12_000 });
    await expect(
      page.getByRole('button', { name: /tests Failed \(exit 1\)/i }).first(),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /tests running/i })).toHaveCount(0);
  });
});
