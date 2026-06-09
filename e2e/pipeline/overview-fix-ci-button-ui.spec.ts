import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for the "Fix CI" action button lifecycle on the project
// overview action bar. The button only renders when the project's aggregate CI
// is `failure` and a ci_failed_url exists. Its label/disabled state must track
// three transitions that had no e2e coverage:
//   1. a running `fix-ci` job  -> "CI Fix in Progress…" + disabled, then back
//      to "Fix CI" + enabled once the job finishes (no reload)
//   2. a failed POST /fix-ci    -> inline error text + button re-enabled
//   3. jobs paused globally     -> disabled with the paused-explainer title

const PROJECT = 'fix-ci-button-ui';
const now = () => Math.floor(Date.now() / 1000);

const CI_FAILED_URL = 'https://ci.example.test/run/123';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
    launchctl: 'running',
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
    // Drives getAggregateCi() -> 'failure' and ciFailedUrl so the button renders.
    ci: 'failure',
    ci_failed_url: CI_FAILED_URL,
    github: null,
    ...overrides,
  };
}

function makeJob(
  id: string,
  kind: string,
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

async function stubOverviewRoutes(
  page: Page,
  opts: {
    jobsPaused?: boolean;
    jobs?: () => Array<Record<string, unknown>>;
  } = {},
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask()], priorities: [], issueCounts: {} },
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
    route.fulfill({
      json: {
        settings: { jobs_paused: opts.jobsPaused ? 'true' : 'false' },
        github_owner: '',
      },
    }),
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
    (route: Route) =>
      route.fulfill({
        json: {
          jobs: opts.jobs ? opts.jobs() : [],
          pendingReleaseProjects: [],
        },
      }),
  );
}

test.describe('Overview Fix CI button lifecycle', () => {
  test('reflects a running fix-ci job, then re-enables once it finishes without reload', async ({
    page,
  }) => {
    let fixCiRunning = true;
    await stubOverviewRoutes(page, {
      jobs: () =>
        fixCiRunning
          ? [makeJob('fix-ci-live', 'fix-ci', 'running', null)]
          : [makeJob('fix-ci-live', 'fix-ci', 'done', 0, { finished_at: now() - 2 })],
    });

    await page.goto(`/project/${PROJECT}`);

    // While the fix-ci job is running, the button shows progress and is disabled.
    const inProgress = page.getByRole('button', { name: /CI Fix in Progress/i });
    await expect(inProgress).toBeVisible({ timeout: 8_000 });
    await expect(inProgress).toBeDisabled();

    // Job finishes -> live poll flips the button back to an enabled "Fix CI".
    fixCiRunning = false;

    const fixCi = page.getByRole('button', { name: /^Fix CI$/ });
    await expect(fixCi).toBeVisible({ timeout: 12_000 });
    await expect(fixCi).toBeEnabled({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /CI Fix in Progress/i })).toHaveCount(0);
  });

  test('surfaces an inline error and re-enables the button when starting the fix fails', async ({
    page,
  }) => {
    await stubOverviewRoutes(page, { jobs: () => [] });
    await page.route(
      `**/api/projects/by-project/${PROJECT}/fix-ci`,
      (route: Route) =>
        route.fulfill({
          status: 500,
          json: { detail: 'CI fix unavailable right now' },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    const fixCi = page.getByRole('button', { name: /^Fix CI$/ });
    await expect(fixCi).toBeEnabled({ timeout: 8_000 });
    await fixCi.click();

    // The failed start surfaces the server detail message inline...
    await expect(page.getByText('CI fix unavailable right now')).toBeVisible({ timeout: 8_000 });
    // ...and the button returns to an actionable state (no orphaned "in progress").
    await expect(fixCi).toBeEnabled({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /CI Fix in Progress/i })).toHaveCount(0);
  });

  test('disables the Fix CI button with a paused explainer when jobs are paused', async ({
    page,
  }) => {
    await stubOverviewRoutes(page, { jobsPaused: true, jobs: () => [] });

    await page.goto(`/project/${PROJECT}`);

    const fixCi = page.getByRole('button', { name: /^Fix CI$/ });
    await expect(fixCi).toBeVisible({ timeout: 8_000 });
    await expect(fixCi).toBeDisabled();
    await expect(fixCi).toHaveAttribute(
      'title',
      'Jobs are paused globally. Resume jobs to start a CI fix.',
    );
  });
});
