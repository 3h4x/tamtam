import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Job lifecycle UI tests — use the 1338 test server with mocked API responses
// to verify that the history tab and overview tab render the correct status
// badges for running, failed, cancelled, and completed jobs.

const PROJECT = 'lifecycle-ui';

const BASE_TASK = {
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
  ci: null,
  ci_failed_url: null,
  github: null,
};

type MockJob = {
  id: string;
  project: string;
  kind: string;
  status: 'running' | 'done';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  verdict?: string;
  session_id?: string;
  pid?: number;
  log_path?: string;
  seen?: boolean;
  parent_job_id?: string | null;
  work_summary?: string | null;
  context_meta?: string | null;
  prompt_bytes?: number | null;
};

async function mockJobScenario(
  page: import('@playwright/test').Page,
  jobs: MockJob[] | (() => MockJob[]),
): Promise<void> {
  const currentJobs = () => typeof jobs === 'function' ? jobs() : jobs;
  // Intercept the projects list so the page finds our project in the fleet.
  await page.route('**/api/projects', (route: Route) => {
    route.fulfill({
      json: {
        tasks: [BASE_TASK],
        priorities: [],
        issueCounts: {},
      },
    });
  });

  // Intercept all jobs requests for this project (with or without &limit= suffix).
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      route.fulfill({ json: { jobs: currentJobs(), pendingReleaseProjects: [] } });
    },
  );

  // Minimal config response so the overview tab doesn't error.
  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) => {
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
          tests_disabled: true,
          review_disabled: false,
          issue_auto_branch: false,
        },
      });
    },
  );

  // Custom actions, agents, branch, behind, issues — return empty/safe values.
  await page.route(
    `**/api/projects/by-project/${PROJECT}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
  );
  await page.route(
    `**/api/agents?project=${PROJECT}`,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/branch`,
    (route: Route) =>
      route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/issues`,
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  );
  // Prevent SSE connection hangs.
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  // Notification bell
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
  );
}

function makeJob(overrides: Partial<MockJob> & Pick<MockJob, 'id' | 'kind' | 'status' | 'exit_code' | 'started_at' | 'finished_at'>): MockJob {
  return {
    project: PROJECT,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  };
}

test.describe('Job lifecycle UI badges', () => {
  const now = () => Math.floor(Date.now() / 1000);

  // -------------------------------------------------------------------------
  // History tab — running job
  // -------------------------------------------------------------------------
  test('running job shows "running" badge in history tab', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-running-1',
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 30,
        finished_at: null,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // VerdictBadge renders "running" when status === 'running'
    await expect(page.getByText('running').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — failed job
  // -------------------------------------------------------------------------
  test('failed job shows "exit 1" badge in history tab', async ({ page }) => {
    // Use kind:'test' — review jobs with no verdict show "review verdict missing"
    // instead of the raw exit code, masking the "exit N" badge we want to test.
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-failed-1',
        kind: 'test',
        status: 'done',
        exit_code: 1,
        started_at: now() - 60,
        finished_at: now() - 30,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    await expect(page.getByText('exit 1').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — cancelled job (exit -3 = aborted pipeline)
  // RunRow maps exit_code=-3 to the "cancelled" label via statusFailureLabel.
  // -------------------------------------------------------------------------
  test('aborted job shows "cancelled" badge in history tab', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-cancelled-1',
        kind: 'test',
        status: 'done',
        exit_code: -3,
        started_at: now() - 90,
        finished_at: now() - 60,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    await expect(page.getByText('cancelled').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — successful job with LGTM verdict
  // -------------------------------------------------------------------------
  test('LGTM review shows "✓ LGTM" verdict badge in history tab', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-lgtm-1',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 60,
        verdict: 'LGTM',
        session_id: 'sess-lgtm-1',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // VerdictBadge renders "✓ LGTM" for a done job with verdict === 'LGTM'
    await expect(page.getByText('✓ LGTM').first()).toBeVisible();
  });

  test('run row shows the newest nested release outcome when multiple releases share the same parent', async ({ page }) => {
    const ts = now();
    const jobs: MockJob[] = [
      makeJob({
        id: 'chat-run-1',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: ts - 500,
        finished_at: ts - 490,
        session_id: 'sess-run-1',
      }),
      makeJob({
        id: 'release-old',
        kind: 'release',
        status: 'done',
        exit_code: 0,
        started_at: ts - 480,
        finished_at: ts - 420,
        parent_job_id: 'chat-run-1',
      }),
      makeJob({
        id: 'release-new',
        kind: 'release',
        status: 'running',
        exit_code: null,
        started_at: ts - 120,
        finished_at: null,
        parent_job_id: 'chat-run-1',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);

    const runRow = page.getByRole('button').filter({ hasText: '(empty prompt)' }).first();
    await expect(runRow.getByText('release running')).toBeVisible();
    await expect(runRow.getByText('✓ release done')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — NEEDS ATTENTION verdict
  // -------------------------------------------------------------------------
  test('NEEDS ATTENTION review shows "⚠ ATTN" verdict badge', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-attn-1',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 60,
        verdict: 'NEEDS ATTENTION',
        session_id: 'sess-attn-1',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    await expect(page.getByText('⚠ ATTN').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — DO NOT SHIP verdict
  // -------------------------------------------------------------------------
  test('DO NOT SHIP review shows "✗ DNS" verdict badge', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-dns-1',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 60,
        verdict: 'DO NOT SHIP',
        session_id: 'sess-dns-1',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // VerdictBadge renders "✗ DNS" for verdict === 'DO NOT SHIP'
    await expect(page.getByText('✗ DNS').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — successful job without verdict shows "done"
  // -------------------------------------------------------------------------
  test('completed push job shows "done" badge in history tab', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-done-push',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        started_at: now() - 60,
        finished_at: now() - 30,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // A push job has no verdict — VerdictBadge shows "done"
    await expect(page.getByText('done').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Overview tab — running jobs banner
  // -------------------------------------------------------------------------
  test('overview tab shows running jobs banner when a job is active', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-running-ov',
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 10,
        finished_at: null,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}`);
    // OverviewTab renders a banner "N running" when there are running jobs
    await expect(page.getByText('1 running').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Overview tab — running jobs banner disappears when no jobs running
  // -------------------------------------------------------------------------
  test('overview tab does not show running banner when no active jobs', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-done-ov',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        started_at: now() - 60,
        finished_at: now() - 30,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}`);
    // { exact: true } avoids matching the persistent "jobs running" header toggle.
    await expect(page.getByText('running', { exact: true })).not.toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — running filter shows only running jobs
  // -------------------------------------------------------------------------
  test('running filter in history tab shows only the running job', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-running-f',
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 5,
        finished_at: null,
      }),
      makeJob({
        id: 'job-done-f',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        started_at: now() - 60,
        finished_at: now() - 30,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // Click the "running" filter chip
    await page.getByRole('button', { name: /running/i }).first().click();
    // Only the running row should be visible, "done" badge should be gone
    await expect(page.getByText('running').first()).toBeVisible();
    await expect(page.getByText('done')).not.toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — failed filter shows only failed jobs
  //
  // Use only one job so the orphaned-pipeline-step clustering logic doesn't
  // collapse the failed and success rows into a single virtual group (which
  // would replace the exact exit code with a normalized "exit 1").
  // -------------------------------------------------------------------------
  test('failed filter in history tab shows only failed jobs', async ({ page }) => {
    // Use kind:'test' so the failure shows the raw exit code badge ("exit 2").
    // Review jobs with no verdict render "review verdict missing" instead.
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-failed-f',
        kind: 'test',
        status: 'done',
        exit_code: 2,
        started_at: now() - 60,
        finished_at: now() - 30,
        session_id: 'sess-failed-f',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // The "failed" filter chip is only rendered when there are failed entries.
    await page.getByRole('button', { name: /failed/i }).first().click();
    await expect(page.getByText('exit 2').first()).toBeVisible();
  });

  test('history tab flips a running job to done without reload', async ({ page }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-1',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-1',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('running', { exact: true })).toBeVisible();

    serveRunning = false;

    await expect(row.getByLabel('done')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText('done', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history tab flips a running job to failed without leaving a running badge', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-failed',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 5,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-failed',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('running', { exact: true })).toBeVisible();

    serveRunning = false;

    await expect(row.getByText('exit 5', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0);
  });

  test('history tab surfaces failure detail after a running job fails via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    const failureDetail = 'Unit test failed: expected checkout guard to block unsafe branch switch';
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-failed-detail',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 1,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-failed-detail',
        work_summary: serveRunning ? null : failureDetail,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('Running tests…')).toBeVisible();

    serveRunning = false;

    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(failureDetail)).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
  });

  test('running filter clears and failed filter picks up a test job failure without reload', async ({
    page,
  }) => {
    let serveRunning = true;
    const failureDetail = 'Integration tests failed after the worker exited with code 4';
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-filter-failure',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 4,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-filter-failure',
        work_summary: serveRunning ? 'Tests are still running' : failureDetail,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();

    await page.getByRole('button', { name: /^running \d+$/i }).click();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();
    await expect(row.getByText('Running tests…')).toBeVisible();

    serveRunning = false;

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    });
    await expect(row).toHaveCount(0);

    const failedFilter = page.getByRole('button', { name: /^failed 1$/i });
    await expect(failedFilter).toBeVisible({ timeout: 12_000 });
    await failedFilter.click();

    const failedRow = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: failureDetail })
      .first();
    await expect(failedRow).toBeVisible({ timeout: 12_000 });
    await expect(failedRow.getByText('exit 4', { exact: true })).toBeVisible();
    await expect(failedRow.getByLabel('running')).toHaveCount(0);
  });

  test('history tab flips a running job to cancelled without leaving a running badge', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-cancelled',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : -3,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-cancelled',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('running', { exact: true })).toBeVisible();

    serveRunning = false;

    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0);
  });

  test('running filter clears when a job is cancelled via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-history-filter-cancelled',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : -3,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-history-filter-cancelled',
        work_summary: serveRunning ? 'Tests are still running' : 'Cancelled by operator',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();

    await page.getByRole('button', { name: /^running \d+$/i }).click();
    await expect(page.getByRole('button', { name: /^running 1$/i })).toBeVisible();
    await expect(row.getByText('Running tests…')).toBeVisible();

    serveRunning = false;

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    });
    await expect(row).toHaveCount(0);

    await page.getByRole('button', { name: /^all \d+$/i }).click();

    const cancelledRow = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ hasText: 'Cancelled by operator' })
      .first();
    await expect(cancelledRow).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByText('cancelled', { exact: true })).toBeVisible();
    await expect(cancelledRow.getByLabel('running')).toHaveCount(0);
  });

  test('history release row surfaces stop reason when it settles without child steps', async ({
    page,
  }) => {
    let serveRunning = true;
    const stopReason = 'review startup failed: prerequisite command exited 1';
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-release-blocked-stop-reason',
        kind: 'release',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 1,
        started_at: now() - 45,
        finished_at: serveRunning ? null : now() - 4,
        context_meta: serveRunning
          ? null
          : JSON.stringify({ releaseStopReason: stopReason }),
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'release' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText(stopReason)).toHaveCount(0);

    serveRunning = false;

    await expect(row.getByText('release blocked', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(row.getByText(stopReason, { exact: false })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0);
  });

  test('overview tab clears active-work banner after the last running job completes', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-overview-1',
        kind: 'review',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 20,
        finished_at: serveRunning ? null : now() - 3,
        verdict: serveRunning ? undefined : 'LGTM',
        session_id: 'sess-live-overview-1',
      }),
    ]);

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('1 running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('review').first()).toBeVisible();

    serveRunning = false;

    await expect(page.getByText('1 running now')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('active work')).toHaveCount(0, { timeout: 12_000 });
  });

  test('overview tab keeps a surviving active job when another job completes via poll', async ({
    page,
  }) => {
    let phase: 'both-running' | 'review-done' | 'all-done' = 'both-running';
    await mockJobScenario(page, () => {
      const reviewRunning = phase === 'both-running';
      const testRunning = phase !== 'all-done';

      return [
        makeJob({
          id: 'job-live-overview-review-peer',
          kind: 'review',
          status: reviewRunning ? 'running' : 'done',
          exit_code: reviewRunning ? null : 0,
          started_at: now() - 30,
          finished_at: reviewRunning ? null : now() - 8,
          verdict: reviewRunning ? undefined : 'LGTM',
          session_id: 'sess-live-overview-review-peer',
        }),
        makeJob({
          id: 'job-live-overview-test-peer',
          kind: 'test',
          status: testRunning ? 'running' : 'done',
          exit_code: testRunning ? null : 0,
          started_at: now() - 20,
          finished_at: testRunning ? null : now() - 4,
          session_id: 'sess-live-overview-test-peer',
        }),
      ];
    });

    await page.goto(`/project/${PROJECT}`);

    const activeWork = page.getByText('active work').locator('..').locator('..').locator('..');

    await expect(page.getByText('2 running now')).toBeVisible({ timeout: 8_000 });
    await expect(activeWork.getByRole('button', { name: /review/i })).toBeVisible({
      timeout: 8_000,
    });
    await expect(activeWork.getByRole('button', { name: /test/i })).toBeVisible({
      timeout: 8_000,
    });

    phase = 'review-done';

    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 12_000 });
    await expect(activeWork.getByRole('button', { name: /test/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(activeWork.getByRole('button', { name: /review/i })).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByText('2 running now')).toHaveCount(0, { timeout: 12_000 });

    phase = 'all-done';

    await expect(page.getByText('active work')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('1 running now')).toHaveCount(0, { timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Overview tab — running banner appears when a new job starts via poll
  // Verifies the live-polling path on the overview tab: the banner must appear
  // on the next poll cycle when a new running job is detected, without reload.
  // -------------------------------------------------------------------------
  test('overview tab shows running banner when a new job appears via poll', async ({ page }) => {
    let serveRunning = false;
    await mockJobScenario(page, () =>
      serveRunning
        ? [
            makeJob({
              id: 'job-live-overview-appear',
              kind: 'review',
              status: 'running',
              exit_code: null,
              started_at: now() - 3,
              finished_at: null,
              session_id: 'sess-live-overview-appear',
            }),
          ]
        : [],
    );

    await page.goto(`/project/${PROJECT}`);

    // No jobs yet — running banner must be absent.
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({ timeout: 5_000 });

    // New job starts — flip the mock.
    serveRunning = true;

    // Overview tab picks up the running job on the next poll cycle.
    await expect(page.getByText('1 running').first()).toBeVisible({ timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // Overview tab — cancelled job clears running banner via poll
  // Complements the success-transition test: verifies the same clearing
  // behaviour when a running job finishes with exit_code=-3 (cancelled).
  // -------------------------------------------------------------------------
  test('overview tab clears active-work banner when running job transitions to cancelled via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-overview-cancel',
        kind: 'review',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : -3,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-overview-cancel',
      }),
    ]);

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('1 running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('review').first()).toBeVisible();

    // Job is cancelled — flip the mock.
    serveRunning = false;

    await expect(page.getByText('1 running now')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('active work')).toHaveCount(0, { timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // History tab — running agent job with non-null work_summary shows
  // liveDetail text, then transitions to completed work_summary on done.
  //
  // Agent and run jobs are "conversational rows" (isConversationalRow=true)
  // and render their work_summary as live progress text while running. This
  // path is distinct from the default subtitle/null path tested elsewhere.
  // -------------------------------------------------------------------------
  test('running agent job shows live work_summary text in history row, then updates on completion', async ({
    page,
  }) => {
    let serveRunning = true;
    const liveText = 'Analyzing 12 TypeScript files for type errors...';
    const doneText = 'Completed. Found 0 errors across 12 files.';

    // Agent jobs use kind='agent:<name>' — the 'agent:' prefix maps the kind
    // to bucket='agent' (isConversationalRow=true). Bare 'agent' maps to
    // bucket='other' which suppresses the liveDetail work_summary path.
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-agent-live-summary',
        kind: 'agent:lint',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-agent-live-summary',
        work_summary: serveRunning ? liveText : doneText,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    // 'agent:lint' → bucket='agent' → KIND_LABEL chip shows 'agent'; title shows 'lint'
    const row = page.getByRole('button')
      .filter({ hasText: 'agent' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    // liveDetail path: agent is a conversational row (bucket='agent'), so non-null
    // work_summary renders as the in-progress detail text below the row heading.
    await expect(row.getByText(liveText, { exact: false })).toBeVisible();

    serveRunning = false;

    // After completion the row flips to done and the final work_summary replaces
    // the live progress text. No page reload should be needed.
    await expect(row.getByLabel('done')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(doneText, { exact: false })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(liveText, { exact: false })).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — running run job shows live work_summary text (same
  // conversational-row code path as agent, but with kind='run').
  // -------------------------------------------------------------------------
  test('running chat run shows live work_summary text and clears it on cancellation', async ({
    page,
  }) => {
    let serveRunning = true;
    const liveText = 'Refactoring the auth module...';

    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-run-live-summary-cancel',
        kind: 'run',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : -3,
        started_at: now() - 20,
        finished_at: serveRunning ? null : now() - 3,
        session_id: 'sess-run-live-cancel',
        work_summary: serveRunning ? liveText : null,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    // 'run' kind displays as 'Chat' in KIND_LABEL, not 'run'. Filter by the
    // session or a unique attribute. Use the session row label pattern instead.
    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText(liveText, { exact: false })).toBeVisible();

    serveRunning = false;

    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 12_000 });
    // Live progress text clears after cancellation — no orphaned progress message.
    await expect(row.getByText(liveText, { exact: false })).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // History tab — running review job flips to a verdict badge via poll.
  //
  // VerdictBadge renders null while a review job is running (isRunning short-
  // circuits before the verdict text). Only once the job settles to done with
  // a verdict does the "⚠ ATTN" / "✗ DNS" / "✓ LGTM" pill appear. Existing live
  // transition tests use kind='test' (raw exit codes) or the overview banner;
  // none assert the review-specific verdict badge appearing live in a row.
  // -------------------------------------------------------------------------
  test('history tab review row gains the ⚠ ATTN verdict badge when it settles via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-review-attn',
        kind: 'review',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 4,
        // Verdict is only known once the review finishes; absent while running.
        verdict: serveRunning ? undefined : 'NEEDS ATTENTION',
        session_id: 'sess-live-review-attn',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'review' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    // While running, no verdict pill is rendered yet.
    await expect(row.getByText('⚠ ATTN')).toHaveCount(0);

    serveRunning = false;

    // The verdict badge appears on the next poll cycle without a reload.
    await expect(row.getByText('⚠ ATTN')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0, { timeout: 12_000 });
  });

  test('history tab review row gains the ✗ DNS verdict badge when it settles via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-review-dns',
        kind: 'review',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 4,
        verdict: serveRunning ? undefined : 'DO NOT SHIP',
        session_id: 'sess-live-review-dns',
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'review' })
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('✗ DNS')).toHaveCount(0);

    serveRunning = false;

    await expect(row.getByText('✗ DNS')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0, { timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // History tab — two concurrent jobs hold independent state
  // Both a test and a review job run at once; when the test job fails the
  // review job must keep its running badge (no cross-row contamination), then
  // each row settles to its own terminal outcome.
  // -------------------------------------------------------------------------
  test('history tab keeps two concurrent jobs independent as each settles via poll', async ({
    page,
  }) => {
    // Use non-pipeline kinds (agent + run) so the two orphaned jobs are NOT
    // clustered into a virtual "Pipeline steps" group by the history util.
    let phase: 'both-running' | 'first-failed' | 'all-done' = 'both-running';
    await mockJobScenario(page, () => {
      const firstRunning = phase === 'both-running';
      const secondRunning = phase !== 'all-done';

      return [
        makeJob({
          id: 'job-concurrent-a',
          kind: 'agent',
          status: firstRunning ? 'running' : 'done',
          exit_code: firstRunning ? null : 1,
          started_at: now() - 40,
          finished_at: firstRunning ? null : now() - 6,
          session_id: 'sess-concurrent-a',
        }),
        makeJob({
          id: 'job-concurrent-b',
          kind: 'run',
          status: secondRunning ? 'running' : 'done',
          exit_code: secondRunning ? null : 0,
          started_at: now() - 35,
          finished_at: secondRunning ? null : now() - 3,
          session_id: 'sess-concurrent-b',
        }),
      ];
    });

    await page.goto(`/project/${PROJECT}/history`);

    const agentRow = page.getByRole('button')
      .filter({ hasText: 'agent' })
      .filter({ hasText: 'started' })
      .first();
    const runRow = page.getByRole('button')
      .filter({ hasText: 'run' })
      .filter({ hasText: 'started' })
      .first();

    // Both jobs start out running, each with its own running badge.
    await expect(agentRow.getByLabel('running')).toBeVisible();
    await expect(runRow.getByLabel('running')).toBeVisible();

    // The agent job fails while the run job keeps running — the run row must
    // not pick up the failure state.
    phase = 'first-failed';

    await expect(agentRow.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(agentRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(runRow.getByLabel('running')).toBeVisible();
    await expect(runRow.getByText('exit 1')).toHaveCount(0);

    // Run job then completes successfully; the agent row stays failed.
    phase = 'all-done';

    await expect(runRow.getByLabel('done')).toBeVisible({ timeout: 12_000 });
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(agentRow.getByText('exit 1', { exact: true })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — failed run job surfaces workSummary via ownSummary path.
  //
  // RunRow.ownSummary = isConversationalRow ? formatRunSummaryText(e.workSummary) : null
  // runSummary = effectiveRunning ? null : (ownFailureDetail ?? ownSummary ?? ...)
  //
  // For a failed run job with no detail but a workSummary, runSummary = ownSummary
  // = workSummary. Existing tests cover the cancelled path (work_summary → null)
  // and the successful path — this test covers the failure path where workSummary
  // carries the failure reason and must survive the running→failed transition.
  // -------------------------------------------------------------------------
  test('failed chat run surfaces workSummary text via poll without leaving a running badge', async ({
    page,
  }) => {
    let serveRunning = true;
    const liveText = 'Scaffolding the new auth middleware...';
    const failureText = 'Run failed: auth provider rejected the connection.';

    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-run-fail-summary',
        kind: 'run',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 1,
        started_at: now() - 25,
        finished_at: serveRunning ? null : now() - 4,
        session_id: 'sess-run-fail-summary',
        work_summary: serveRunning ? liveText : failureText,
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    // While running, liveDetail shows the in-progress workSummary.
    await expect(row.getByText(liveText, { exact: false })).toBeVisible();

    serveRunning = false;

    // After failure: exit 1 badge appears, live liveText replaced by failureText
    // via runSummary (ownSummary path), running badge clears.
    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(failureText, { exact: false })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(liveText, { exact: false })).toHaveCount(0, { timeout: 12_000 });
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
  });

  // -------------------------------------------------------------------------
  // History tab — failed run job surfaces detail over workSummary.
  //
  // RunRow.ownFailureDetail = !running && effectiveNeedsAttention && isConversationalRow
  //   ? formatRunSummaryText(e.detail) : null
  // runSummary = ownFailureDetail ?? ownSummary ?? ...
  //
  // When a run job fails with both detail and workSummary, detail takes
  // precedence (ownFailureDetail ?? ownSummary). Neither path is tested for
  // the conversational failure case without explicit test coverage.
  // -------------------------------------------------------------------------
  test('failed chat run shows detail text (not workSummary) when both are present', async ({
    page,
  }) => {
    const detailText = 'Provider error: token limit exceeded on attempt 3.';
    const workSummaryText = 'Refactored the token cache layer.';

    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-run-detail-precedence',
        kind: 'run',
        status: 'done',
        exit_code: 1,
        started_at: now() - 60,
        finished_at: now() - 10,
        session_id: 'sess-run-detail-precedence',
        work_summary: workSummaryText,
      }),
    ]);

    // The makeJob helper does not support the detail field — add it via a
    // separate route override by extending the base mock. We use a fresh
    // page.route after mockJobScenario to inject the extra field.
    // Playwright matches later-registered routes first, so this overrides
    // the job list returned by mockJobScenario.
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route) => {
        route.fulfill({
          json: {
            jobs: [
              {
                id: 'job-run-detail-precedence',
                project: PROJECT,
                kind: 'run',
                status: 'done',
                exit_code: 1,
                started_at: now() - 60,
                finished_at: now() - 10,
                pid: 0,
                log_path: '',
                seen: true,
                session_id: 'sess-run-detail-precedence',
                work_summary: workSummaryText,
                detail: detailText,
              },
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible({ timeout: 8_000 });
    // detail takes precedence over workSummary via ownFailureDetail ?? ownSummary.
    await expect(row.getByText(detailText, { exact: false })).toBeVisible({ timeout: 8_000 });
    // workSummary must NOT be shown when detail is present for a failed run row.
    await expect(row.getByText(workSummaryText, { exact: false })).toHaveCount(0);
    await expect(row.getByLabel('running')).toHaveCount(0);
  });

  test('history chat row gains unfinished outcome badge when it settles via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-run-outcome-needs-continue',
        kind: 'run',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 0,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 4,
        session_id: 'sess-run-outcome-needs-continue',
        context_meta: serveRunning
          ? null
          : JSON.stringify({ outcomeClassification: { verdict: 'needs_continue' } }),
      }),
    ]);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText('↻ unfinished')).toHaveCount(0);

    serveRunning = false;

    const outcomeBadge = row.getByText('↻ unfinished', { exact: true });
    await expect(outcomeBadge).toBeVisible({ timeout: 12_000 });
    await expect(outcomeBadge).toHaveAttribute(
      'title',
      'Local-LLM outcome verdict: needs continue',
    );
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history review row shows follow-up issue link and alert prompt-size chip', async ({
    page,
  }) => {
    const followupUrl = 'https://github.com/example/repo/issues/42';
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-review-followup-prompt-alert',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 80,
        finished_at: now() - 20,
        verdict: 'DO NOT SHIP',
        session_id: 'sess-review-followup-prompt-alert',
        prompt_bytes: 52_224,
        context_meta: JSON.stringify({
          followupIssueUrl: followupUrl,
          followupIssueNumber: 42,
        }),
      }),
      makeJob({
        id: 'job-run-prompt-below-threshold',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 90,
        session_id: 'sess-run-prompt-below-threshold',
        prompt_bytes: 19_456,
      }),
    ];
    await mockJobScenario(page, jobs);

    await page.goto(`/project/${PROJECT}/history`);

    const reviewRow = page.getByRole('button')
      .filter({ hasText: 'review' })
      .filter({ hasText: 'started' })
      .first();
    await expect(reviewRow).toBeVisible();

    const followupLink = reviewRow.getByRole('link', { name: '↗ filed #42' });
    await expect(followupLink).toBeVisible();
    await expect(followupLink).toHaveAttribute('href', followupUrl);

    const promptChip = reviewRow.getByText('prompt 51KB', { exact: true });
    await expect(promptChip).toBeVisible();
    await expect(promptChip).toHaveClass(/text-status-error/);
    await expect(promptChip).toHaveAttribute(
      'title',
      /Prompt piped to provider: 52,224 bytes/,
    );

    await expect(page.getByText('prompt 19KB', { exact: true })).toHaveCount(0);
  });

  test('history chat rows show done and asked outcome chips with their tones', async ({
    page,
  }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-run-outcome-done',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: now() - 40,
        finished_at: now() - 10,
        session_id: 'sess-run-outcome-done',
        context_meta: JSON.stringify({ outcomeClassification: { verdict: 'done' } }),
      }),
      makeJob({
        id: 'job-run-outcome-asked',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 90,
        session_id: 'sess-run-outcome-asked',
        context_meta: JSON.stringify({ outcomeClassification: { verdict: 'asked_question' } }),
      }),
    ];
    await mockJobScenario(page, jobs);

    await page.goto(`/project/${PROJECT}/history`);

    // `done` → "✓ done", success tone.
    const doneChip = page.getByText('✓ done', { exact: true });
    await expect(doneChip).toBeVisible();
    await expect(doneChip).toHaveClass(/text-status-success/);
    await expect(doneChip).toHaveAttribute(
      'title',
      'Local-LLM outcome verdict: done',
    );

    // `asked_question` → "? asked", info tone.
    const askedChip = page.getByText('? asked', { exact: true });
    await expect(askedChip).toBeVisible();
    await expect(askedChip).toHaveClass(/text-status-info/);
    await expect(askedChip).toHaveAttribute(
      'title',
      'Local-LLM outcome verdict: asked question',
    );
  });

  test('history row shows warn-tone prompt chip at the 20KB boundary', async ({
    page,
  }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-run-prompt-warn-boundary',
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: now() - 60,
        finished_at: now() - 20,
        session_id: 'sess-run-prompt-warn-boundary',
        // Exactly the warn threshold (PROMPT_BYTES_WARN = 20_000), below the
        // alert threshold (50_000) — chip shows in warning tone, not error.
        prompt_bytes: 20_000,
      }),
    ];
    await mockJobScenario(page, jobs);

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'started' })
      .first();
    await expect(row).toBeVisible();

    const promptChip = row.getByText('prompt 20KB', { exact: true });
    await expect(promptChip).toBeVisible();
    await expect(promptChip).toHaveClass(/text-status-warning/);
    // Must NOT escalate to the alert (error) styling at the warn boundary.
    await expect(promptChip).not.toHaveClass(/text-status-error/);
    await expect(promptChip).toHaveAttribute(
      'title',
      /Prompt piped to provider: 20,000 bytes/,
    );
  });
});
