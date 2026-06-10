import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Mocked-API UI tests for the Release button behaviour when jobs are globally
// paused or when the pipeline is already running.  These tests hit the configured baseURL
// but intercept every API call — no real pipeline execution involved.

const PROJECT = 'paused-release-ui';
const now = () => Math.floor(Date.now() / 1000);

function releaseButton(page: import('@playwright/test').Page) {
  return page.getByRole('button', { name: 'Release', exact: true });
}

function projectIssuesPathMatcher(url: URL) {
  return url.pathname === `/api/projects/by-project/${PROJECT}/issues`;
}

function projectIssuesMatcher(url: URL) {
  return projectIssuesPathMatcher(url) && url.searchParams.get('summary') !== '1';
}

function projectIssuesSummaryMatcher(url: URL) {
  return projectIssuesPathMatcher(url) && url.searchParams.get('summary') === '1';
}

function emptyIssuesSummary() {
  return {
    repo: '',
    prCount: 0,
    issueCount: 0,
    openPrBranches: [],
    error: null,
    cached: false,
    cachedAt: now(),
  };
}

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
  await page.route(projectIssuesSummaryMatcher, (route: Route) =>
    route.fulfill({ json: emptyIssuesSummary() }),
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
  await page.route(projectIssuesMatcher, (route: Route) =>
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

  const releaseBtn = releaseButton(page);
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
});

test('Release button disables in place when jobs_paused flips on while the page stays open', async ({
  page,
}) => {
  let jobsPaused = false;

  await stubCommonRoutes(page);
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: jobsPaused ? 'true' : 'false' },
        github_owner: '',
      },
    }),
  );

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = releaseButton(page);
  const stableUrl = page.url();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeEnabled();

  jobsPaused = true;

  await expect(releaseBtn).toBeDisabled({ timeout: 12_000 });
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
  await expect(page).toHaveURL(stableUrl);
});

test('overview Release button disables in place when jobs_paused flips on while the page stays open', async ({
  page,
}) => {
  let jobsPaused = false;

  await stubCommonRoutes(page);
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: jobsPaused ? 'true' : 'false' },
        github_owner: '',
      },
    }),
  );

  await page.goto(`/project/${PROJECT}`);

  const releaseBtn = releaseButton(page);
  const stableUrl = page.url();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeEnabled();

  jobsPaused = true;

  await expect(releaseBtn).toBeDisabled({ timeout: 12_000 });
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
  await expect(page.getByRole('switch', { name: /jobs paused/i })).toBeChecked();
  await expect(page).toHaveURL(stableUrl);
});

test('overview Release button re-enables in place when jobs_paused clears while the page stays open', async ({
  page,
}) => {
  let jobsPaused = true;

  await stubCommonRoutes(page);
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: jobsPaused ? 'true' : 'false' },
        github_owner: '',
      },
    }),
  );

  await page.goto(`/project/${PROJECT}`);

  const releaseBtn = releaseButton(page);
  const pauseSwitch = page.getByRole('switch');
  const stableUrl = page.url();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
  await expect(pauseSwitch).toHaveText('jobs paused');
  await expect(pauseSwitch).toBeChecked();

  jobsPaused = false;

  await expect(releaseBtn).toBeEnabled({ timeout: 12_000 });
  await expect(releaseBtn).toHaveAttribute('title', /Release: review/i);
  await expect(pauseSwitch).toHaveText('jobs running', { timeout: 12_000 });
  await expect(pauseSwitch).not.toBeChecked();
  await expect(page).toHaveURL(stableUrl);
});

test('issues Release button re-enables in place when jobs_paused clears while the page stays open', async ({
  page,
}) => {
  let jobsPaused = true;

  await stubCommonRoutes(page);
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: jobsPaused ? 'true' : 'false' },
        github_owner: '',
      },
    }),
  );

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = releaseButton(page);
  const pauseSwitch = page.getByRole('switch');
  const stableUrl = page.url();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
  await expect(pauseSwitch).toBeChecked();

  jobsPaused = false;

  await expect(releaseBtn).toBeEnabled({ timeout: 12_000 });
  await expect(releaseBtn).toHaveAttribute('title', /Release: review/i);
  await expect(pauseSwitch).toHaveText('jobs running', { timeout: 12_000 });
  await expect(pauseSwitch).not.toBeChecked({ timeout: 12_000 });
  await expect(page).toHaveURL(stableUrl);
});

test('history Release button disables in place when jobs_paused flips on while the page stays open', async ({
  page,
}) => {
  let jobsPaused = false;

  await stubCommonRoutes(page);
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: jobsPaused ? 'true' : 'false' },
        github_owner: '',
      },
    }),
  );

  await page.goto(`/project/${PROJECT}/history`);

  const releaseBtn = releaseButton(page);
  const stableUrl = page.url();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeEnabled();

  jobsPaused = true;

  await expect(releaseBtn).toBeDisabled({ timeout: 12_000 });
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
  await expect(page.getByRole('switch', { name: /jobs paused/i })).toBeChecked();
  await expect(page).toHaveURL(stableUrl);
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
  const releaseBtn = releaseButton(page);
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

  const releaseBtn = releaseButton(page);
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).not.toBeDisabled();

  await releaseBtn.click();

  // The toast must mention the blocking job ID.
  await expect(
    page.getByText(new RegExp(blockingJobId)),
  ).toBeVisible({ timeout: 5_000 });
});

test('release click blocked by an ordinary run restores the idle button and shows the blocker detail', async ({
  page,
}) => {
  await stubCommonRoutes(page);

  let releaseResponse!: () => void;
  const releasePending = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });

  await page.route(`**/api/projects/by-project/${PROJECT}/release`, async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    await releasePending;
    await route.fulfill({
      status: 409,
      json: {
        detail: `Job 'run' is already running for ${PROJECT} (job ordinary-run-123)`,
        blocking_job_id: 'ordinary-run-123',
      },
    });
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const idleBtn = releaseButton(page);
  await expect(idleBtn).toBeVisible({ timeout: 8_000 });
  await expect(idleBtn).toBeEnabled();

  await idleBtn.click();

  const busyBtn = page.getByRole('button', { name: 'Releasing…', exact: true });
  await expect(busyBtn).toBeVisible({ timeout: 5_000 });
  await expect(busyBtn).toBeDisabled();

  releaseResponse();

  await expect(idleBtn).toBeVisible({ timeout: 8_000 });
  await expect(idleBtn).toBeEnabled();
  await expect(busyBtn).toHaveCount(0, { timeout: 8_000 });
  await expect(page.getByText(/Job 'run' is already running/i)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/Pipeline is running/i)).toHaveCount(0);
});

test('release click blocked by another release still restores the idle button and keeps the pipeline-running guidance', async ({
  page,
}) => {
  await stubCommonRoutes(page);

  let releaseResponse!: () => void;
  const releasePending = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });

  const blockingJobId = 'release-blocking-456';

  await page.route(`**/api/projects/by-project/${PROJECT}/release`, async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    await releasePending;
    await route.fulfill({
      status: 409,
      json: {
        detail: `Release pipeline already running for ${PROJECT}`,
        blocking_job_id: blockingJobId,
      },
    });
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const idleBtn = releaseButton(page);
  await expect(idleBtn).toBeVisible({ timeout: 8_000 });

  await idleBtn.click();

  const busyBtn = page.getByRole('button', { name: 'Releasing…', exact: true });
  await expect(busyBtn).toBeVisible({ timeout: 5_000 });
  await expect(busyBtn).toBeDisabled();

  releaseResponse();

  await expect(idleBtn).toBeVisible({ timeout: 8_000 });
  await expect(idleBtn).toBeEnabled();
  await expect(busyBtn).toHaveCount(0, { timeout: 8_000 });
  await expect(page.getByText(new RegExp(blockingJobId))).toBeVisible({ timeout: 5_000 });
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

  const releaseBtn = releaseButton(page);
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
  await page.route(projectIssuesSummaryMatcher, (route: Route) =>
    route.fulfill({ json: emptyIssuesSummary() }),
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
  await page.route(projectIssuesMatcher, (route: Route) =>
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
  const releaseBtn = releaseButton(page);
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
  await page.route(projectIssuesSummaryMatcher, (route: Route) =>
    route.fulfill({
      json: {
        repo: '',
        prCount: 1,
        issueCount: 0,
        openPrBranches: [{ branch: 'fix/issue-77-gates', number: 77 }],
        error: null,
        cached: false,
        cachedAt: now(),
      },
    }),
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
  await page.route(projectIssuesMatcher, (route: Route) =>
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

  const releaseBtn = releaseButton(page);
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
  await page.route(projectIssuesMatcher, (route: Route) =>
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

  const releaseBtn = releaseButton(page);
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

test('issues page picks up external jobs_paused changes and disables release controls without reload', async ({
  page,
}) => {
  let jobsPaused = false;

  await stubCommonRoutes(page);
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: jobsPaused ? 'true' : 'false' },
        github_owner: '',
      },
    }),
  );

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = releaseButton(page);

  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeEnabled();

  jobsPaused = true;

  await expect(releaseBtn).toBeDisabled({ timeout: 12_000 });
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);

  jobsPaused = false;

  await expect(releaseBtn).toBeEnabled({ timeout: 12_000 });
  await expect(releaseBtn).not.toHaveAttribute('title', /jobs are paused globally/i);
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
  const releaseBtn = page.getByRole('button', { name: 'Releasing…', exact: true });
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
  const busyBtn = page.getByRole('button', { name: 'Releasing…', exact: true });
  await expect(busyBtn).toBeVisible({ timeout: 8_000 });
  await expect(busyBtn).toBeDisabled();

  // Flip the mock so the next 10 s poll returns no running jobs.
  jobRunning = false;

  // Phase 2: within 15 s the poll fires, isPipelineRunning flips to false,
  // and the Release button re-enables — no page.reload().
  const idleBtn = releaseButton(page);
  await expect(idleBtn).toBeVisible({ timeout: 15_000 });
  await expect(idleBtn).toBeEnabled();
  await expect(busyBtn).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 9: busy + jobs_paused overlap — label stays busy, title follows pause
// The button text is driven by busy state, while the tooltip prioritizes the
// global pause message. As the backend clears pause first and running second,
// the control should move through those states without a reload.
// ---------------------------------------------------------------------------
test('Release button keeps the busy label but adopts the pause tooltip when jobs are paused mid-release, then unwinds in order', async ({
  page,
}) => {
  const ts = Math.floor(Date.now() / 1000);
  let jobRunning = true;
  let jobsPaused = false;

  await stubCommonRoutes(page);
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: jobsPaused ? 'true' : 'false' },
        github_owner: '',
      },
    }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          jobs: jobRunning
            ? [
                {
                  id: 'running-review-pause-overlap',
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

  const busyBtn = page.getByRole('button', { name: 'Releasing…', exact: true });
  await expect(busyBtn).toBeVisible({ timeout: 8_000 });
  await expect(busyBtn).toBeDisabled();
  await expect(busyBtn).toHaveAttribute('title', /release pipeline already running/i);

  jobsPaused = true;

  await expect(busyBtn).toHaveAttribute('title', /jobs are paused globally/i, {
    timeout: 12_000,
  });
  await expect(busyBtn).toBeDisabled();

  jobsPaused = false;

  await expect(busyBtn).toHaveAttribute('title', /release pipeline already running/i, {
    timeout: 12_000,
  });
  await expect(busyBtn).toBeDisabled();

  jobRunning = false;

  const idleBtn = releaseButton(page);
  await expect(idleBtn).toBeVisible({ timeout: 15_000 });
  await expect(idleBtn).toBeEnabled();
  await expect(idleBtn).not.toHaveAttribute('title', /jobs are paused globally|release pipeline already running/i);
  await expect(busyBtn).not.toBeVisible();
});
