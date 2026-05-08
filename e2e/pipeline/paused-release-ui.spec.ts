import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Mocked-API UI tests for the Release button behaviour when jobs are globally
// paused or when the pipeline is already running.  These tests hit port 1338
// but intercept every API call — no real pipeline execution involved.

const PROJECT = 'paused-release-ui';
const now = () => Math.floor(Date.now() / 1000);

function makeTask(project: string, changes = 5, unpushed = 0) {
  return {
    id: `${project}-1`,
    project,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${project}`,
    fires_at: '',
    sync: true,
    changes,
    unpushed,
    reviewed: false,
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

async function stubCommonRoutes(
  page: import('@playwright/test').Page,
  settingsOverride?: Record<string, unknown>,
): Promise<void> {
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
          tests_disabled: true,
          review_disabled: false,
          issue_auto_branch: false,
        },
      }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({
      json: { branch: 'master', defaultBranch: 'master', commitsAhead: null },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: settingsOverride
        ? { settings: settingsOverride, github_owner: '' }
        : { settings: { jobs_paused: 'false' }, github_owner: '' },
    }),
  );
  // No running jobs — so isPipelineRunning = false and Release button is active.
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
}

// ---------------------------------------------------------------------------
// Test 0: jobs paused — release button disabled before click
// ---------------------------------------------------------------------------
test('Release button is disabled up front when jobs are paused globally', async ({
  page,
}) => {
  await stubCommonRoutes(page, { jobs_paused: 'true' });

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
});

// ---------------------------------------------------------------------------
// Test 1: jobs paused — toast must show server's "paused" detail message
// ---------------------------------------------------------------------------
test('clicking Release when jobs are paused shows a "paused" toast, not "already running"', async ({
  page,
}) => {
  await stubCommonRoutes(page);

  // Mock the release endpoint to return the paused 409 response.
  await page.route(`**/api/projects/by-project/${PROJECT}/release`, (route: Route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 409,
        json: {
          detail: 'Jobs are paused globally. Turn the switch back on in Settings to start new jobs.',
        },
      });
    } else {
      route.continue();
    }
  });

  await page.goto(`/project/${PROJECT}/issues`);

  // Release button is enabled when changes > 0 and pipeline is idle.
  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).not.toBeDisabled();

  await releaseBtn.click();

  // The toast must mention "paused" — NOT "already running".
  await expect(page.getByText(/paused/i).first()).toBeVisible({ timeout: 5_000 });
  // Explicitly check that the wrong message is absent.
  await expect(page.getByText(/already running/i)).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 2: pipeline already running — toast shows the blocked-job message
// ---------------------------------------------------------------------------
test('clicking Release when pipeline is already running shows a "Pipeline is running" toast', async ({
  page,
}) => {
  await stubCommonRoutes(page);

  const blockingJobId = 'job-blocking-123';

  await page.route(`**/api/projects/by-project/${PROJECT}/release`, (route: Route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 409,
        json: {
          detail: `Release pipeline already running for ${PROJECT}`,
          blocking_job_id: blockingJobId,
        },
      });
    } else {
      route.continue();
    }
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).not.toBeDisabled();

  await releaseBtn.click();

  // The toast must mention the blocking job ID.
  await expect(
    page.getByText(new RegExp(blockingJobId)),
  ).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Test 3: successful release — toast shows success and navigates to terminal
// ---------------------------------------------------------------------------
test('successful release shows an info toast with the step name', async ({ page }) => {
  await stubCommonRoutes(page);

  await page.route(`**/api/projects/by-project/${PROJECT}/release`, (route: Route) => {
    if (route.request().method() === 'POST') {
      // Omit job_id / release_job_id so router.push is NOT called — this keeps
      // us on the project page and lets us assert the toast without a race.
      route.fulfill({
        status: 200,
        json: {
          status: 'started',
          step: 'review',
          message: 'Review started',
        },
      });
    } else {
      route.continue();
    }
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });

  await releaseBtn.click();

  // Toast should mention the step name from the server response.
  await expect(page.getByText(/review.*started|started.*review/i).first()).toBeVisible({
    timeout: 5_000,
  });
});

// ---------------------------------------------------------------------------
// Test 4: release button disabled when nothing to release (changes = 0)
// ---------------------------------------------------------------------------
test('Release button is disabled when there are no local changes', async ({ page }) => {
  // Override the projects mock to return changes = 0 and unpushed = 0.
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(PROJECT, 0, 0)], priorities: [], issueCounts: {} },
    }),
  );
  // Stub remaining routes.
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
          tests_disabled: true,
          review_disabled: false,
          issue_auto_branch: false,
        },
      }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );

  await page.goto(`/project/${PROJECT}/issues`);

  // Release button should exist but be disabled.
  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
});

// ---------------------------------------------------------------------------
// Test 5: release button disabled when jobs are paused globally
// ---------------------------------------------------------------------------
test('Release button is disabled when jobs are paused globally', async ({ page }) => {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(PROJECT, 5, 0)], priorities: [], issueCounts: {} },
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
          tests_disabled: true,
          review_disabled: false,
          issue_auto_branch: false,
        },
      }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'true' }, github_owner: '' } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
});

// ---------------------------------------------------------------------------
// Test 6: toggling the header pause switch updates Release and PR Review live
// ---------------------------------------------------------------------------
test('header pause toggle updates Release and PR Review without reloading', async ({ page }) => {
  let jobsPaused = false;

  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(PROJECT, 5, 0)], priorities: [], issueCounts: {} },
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
          tests_disabled: true,
          review_disabled: false,
          issue_auto_branch: false,
        },
      }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({
      json: {
        prs: [{
          number: 77,
          title: 'Improve release gating',
          state: 'OPEN',
          author: { login: 'octocat' },
          url: 'https://github.com/acme/widgets/pull/77',
          createdAt: '2026-05-01T10:00:00Z',
          updatedAt: '2026-05-01T10:00:00Z',
          headRefName: 'fix/issue-77-gates',
          baseRefName: 'master',
          isDraft: false,
          reviewDecision: 'REVIEW_REQUIRED',
          labels: [],
          body: 'Fixes #77',
          statusCheckRollup: null,
        }],
        issues: [],
      },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/pr-gates**`, (route: Route) =>
    route.fulfill({
      json: {
        issueNumber: null,
        tests: 'pass',
        review: 'warn',
        dod: 'warn',
        dodSummary: '2/2',
      },
    }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/usage/quota', (route: Route) =>
    route.fulfill({
      json: {
        gateEnabled: false,
        sevenDay: { utilization: 0, resetsAt: null, msUntilReset: null },
      },
    }),
  );
  await page.route('**/api/settings', async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { jobs_paused?: string };
      jobsPaused = body.jobs_paused === 'true';
      await route.fulfill({ json: { ok: true } });
      return;
    }

    await route.fulfill({
      json: { settings: { jobs_paused: jobsPaused ? 'true' : 'false' }, github_owner: '' },
    });
  });
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  const reviewBtn = page.getByRole('button', { name: 'Review', exact: true });
  const dodBtn = page.getByRole('button', { name: /2\/2/i });
  const pauseToggle = page.getByRole('switch');

  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(reviewBtn).toBeVisible({ timeout: 8_000 });
  await expect(dodBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeEnabled();
  await expect(reviewBtn).toBeEnabled();
  await expect(dodBtn).toBeEnabled();
  await expect(releaseBtn).not.toHaveAttribute('title', /jobs are paused globally/i);
  await expect(reviewBtn).not.toHaveAttribute('title', /jobs are paused globally/i);
  await expect(dodBtn).not.toHaveAttribute('title', /jobs are paused globally/i);

  await pauseToggle.click();
  await expect(releaseBtn).toBeDisabled();
  await expect(reviewBtn).toBeDisabled();
  await expect(dodBtn).toBeDisabled();
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
  await expect(reviewBtn).toHaveAttribute('title', /jobs are paused globally/i);
  await expect(dodBtn).toHaveAttribute('title', /jobs are paused globally/i);

  await pauseToggle.click();
  await expect(releaseBtn).toBeEnabled();
  await expect(reviewBtn).toBeEnabled();
  await expect(dodBtn).toBeEnabled();
  await expect(releaseBtn).not.toHaveAttribute('title', /jobs are paused globally/i);
  await expect(reviewBtn).not.toHaveAttribute('title', /jobs are paused globally/i);
  await expect(dodBtn).not.toHaveAttribute('title', /jobs are paused globally/i);
});

// ---------------------------------------------------------------------------
// Test 7: isPipelineRunning → button pre-disabled with "Releasing…" label
// Covers the isPipelineBusy() path: when a pipeline-kind job is actively
// running, the Release button must be disabled before the user clicks it.
// This is distinct from the jobsPaused (title: "Jobs are paused") and
// nothingToRelease (no changes) cases already tested above.
// ---------------------------------------------------------------------------
test('Release button shows "Releasing…" and is pre-disabled when a pipeline job is actively running', async ({
  page,
}) => {
  const ts = Math.floor(Date.now() / 1000);

  await stubCommonRoutes(page);
  // Override /api/jobs to return a running review job so isPipelineBusy() returns true.
  // Playwright matches later-registered handlers first, so this wins over the helper's stub.
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          jobs: [
            {
              id: 'running-review-busy',
              project: PROJECT,
              kind: 'review',
              status: 'running',
              exit_code: null,
              started_at: ts - 30,
              finished_at: null,
              pid: 0,
              log_path: '',
              seen: true,
            },
          ],
          pendingReleaseProjects: [],
        },
      }),
  );

  await page.goto(`/project/${PROJECT}/issues`);

  // busy=true → button text changes to "Releasing…" and becomes disabled.
  // Note: button is NOT disabled because of jobsPaused — the title should say
  // "Release pipeline already running", not "Jobs are paused globally".
  const releaseBtn = page.getByRole('button', { name: /releasing/i });
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
  await expect(releaseBtn).toHaveAttribute('title', /release pipeline already running/i);
  await expect(releaseBtn).not.toHaveAttribute('title', /jobs are paused globally/i);
});

// ---------------------------------------------------------------------------
// Test 8: Release button re-enables via poll when running job finishes
// The ProjectDetailPage polls /api/jobs every 10 s. When the running pipeline
// job finishes, the next poll must flip isPipelineRunning → false and restore
// the Release button to its enabled "🚀 Release" state without a page reload.
// ---------------------------------------------------------------------------
test('Release button re-enables without page reload when the running pipeline job finishes', async ({
  page,
}) => {
  const ts = Math.floor(Date.now() / 1000);
  let jobRunning = true;

  await stubCommonRoutes(page);
  // Dynamic /api/jobs override: returns a running job initially, then an empty list.
  // Playwright matches later-registered handlers first, so this wins over the helper's stub.
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          jobs: jobRunning
            ? [
                {
                  id: 'running-review-transition',
                  project: PROJECT,
                  kind: 'review',
                  status: 'running',
                  exit_code: null,
                  started_at: ts - 30,
                  finished_at: null,
                  pid: 0,
                  log_path: '',
                  seen: true,
                },
              ]
            : [],
          pendingReleaseProjects: [],
        },
      }),
  );

  await page.goto(`/project/${PROJECT}/issues`);

  // Phase 1: pipeline is busy → button shows "Releasing…" and is disabled.
  // Note: "Releasing…" does NOT match /release/i ("releas" matches but the 7th
  // char is 'i' not 'e'), so we match with /releasing/i for the busy state.
  const busyBtn = page.getByRole('button', { name: /releasing/i });
  await expect(busyBtn).toBeVisible({ timeout: 8_000 });
  await expect(busyBtn).toBeDisabled();

  // Flip the mock so the next 10 s poll returns no running jobs.
  jobRunning = false;

  // Phase 2: within 15 s the poll fires, isPipelineRunning flips to false,
  // and the Release button re-enables (text changes to "🚀 Release") — no page.reload().
  const idleBtn = page.getByRole('button', { name: '🚀 Release' });
  await expect(idleBtn).toBeVisible({ timeout: 15_000 });
  await expect(idleBtn).toBeEnabled();
  await expect(busyBtn).not.toBeVisible();
});
