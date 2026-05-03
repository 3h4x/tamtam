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
};

async function mockJobScenario(
  page: import('@playwright/test').Page,
  jobs: MockJob[],
): Promise<void> {
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
      route.fulfill({ json: { jobs, pendingReleaseProjects: [] } });
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
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-failed-1',
        kind: 'review',
        status: 'done',
        exit_code: 1,
        started_at: now() - 60,
        finished_at: now() - 30,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // VerdictBadge renders "exit ${exitCode}" when isFailed
    await expect(page.getByText('exit 1').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // History tab — cancelled job (exit -3 = aborted pipeline)
  // -------------------------------------------------------------------------
  test('aborted job shows "exit -3" badge in history tab', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-cancelled-1',
        kind: 'release',
        status: 'done',
        exit_code: -3,
        started_at: now() - 90,
        finished_at: now() - 60,
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    await expect(page.getByText('exit -3').first()).toBeVisible();
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
    await expect(page.getByText('running')).not.toBeVisible();
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
    const jobs: MockJob[] = [
      makeJob({
        id: 'job-failed-f',
        kind: 'review',
        status: 'done',
        exit_code: 2,
        started_at: now() - 60,
        finished_at: now() - 30,
        // Give it a session_id so it doesn't get merged with anything else
        session_id: 'sess-failed-f',
      }),
    ];
    await mockJobScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);
    // The "failed" filter chip is only rendered when there are failed entries.
    await page.getByRole('button', { name: /failed/i }).first().click();
    await expect(page.getByText('exit 2').first()).toBeVisible();
  });
});
