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

async function stubCommonRoutes(page: import('@playwright/test').Page): Promise<void> {
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
    route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
  );
  // No running jobs — so isPipelineRunning = false and Release button is active.
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
}

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

  await page.goto(`/project/${PROJECT}`);

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

  await page.goto(`/project/${PROJECT}`);

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

  await page.goto(`/project/${PROJECT}`);

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
    route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );

  await page.goto(`/project/${PROJECT}`);

  // Release button should exist but be disabled.
  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
});
