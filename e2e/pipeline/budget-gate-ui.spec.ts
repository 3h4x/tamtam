import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Budget-gate UI tests — verify that a 429 response from the release endpoint
// surfaces the quota-exceeded detail in an error toast, distinct from the 409
// "paused" and "already running" cases already tested in paused-release-ui.spec.ts.
//
// The budget gate fires inside the server after the pause check passes; the
// client receives HTTP 429 with { detail: "…quota exceeded…" }. Since
// isPipelineLocked is false for 429 responses, the code goes to the else branch
// in handleRelease and calls toast(error.message, 'error').

const PROJECT = 'budget-gate-ui';

function makeTask(project: string, changes = 5) {
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
    unpushed: 0,
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
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
}

// ---------------------------------------------------------------------------
// Test 1: 429 budget-blocked — error toast shows quota detail
// ---------------------------------------------------------------------------
test('clicking Release when budget is exhausted shows quota-exceeded error toast', async ({
  page,
}) => {
  await stubCommonRoutes(page);

  const QUOTA_DETAIL =
    'Claude quota exceeded (5h at 97%). Will resume after 11:30:00 PM.';

  await page.route(`**/api/projects/by-project/${PROJECT}/release`, (route: Route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 429,
        json: { detail: QUOTA_DETAIL },
      });
    } else {
      route.continue();
    }
  });

  await page.goto(`/project/${PROJECT}/issues`);

  // Button is enabled — budget gate does NOT pre-disable the button (unlike jobs_paused).
  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).not.toBeDisabled();
  await expect(releaseBtn).not.toHaveAttribute('title', /paused globally/i);

  await releaseBtn.click();

  // Error toast must show the server-supplied quota detail.
  await expect(page.getByText(/quota exceeded/i).first()).toBeVisible({ timeout: 5_000 });

  // Explicitly confirm neither the paused nor locked messages appear.
  await expect(page.getByText(/paused/i)).not.toBeVisible();
  await expect(page.getByText(/already running/i)).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 2: 429 credits-exhausted variant — distinct detail text
// ---------------------------------------------------------------------------
test('budget-blocked toast shows the credit-gate detail string for credits-exhausted variant', async ({
  page,
}) => {
  await stubCommonRoutes(page);

  const CREDITS_DETAIL =
    'Claude credits exhausted (100%). Will resume when quota or credits are available.';

  await page.route(`**/api/projects/by-project/${PROJECT}/release`, (route: Route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 429,
        json: { detail: CREDITS_DETAIL },
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

  // Error toast shows credits-exhausted message.
  await expect(page.getByText(/credits exhausted/i).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/paused/i)).not.toBeVisible();
  await expect(page.getByText(/already running/i)).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 3: 429 budget-blocked — button NOT pre-disabled even when jobs are
// running (budget gate fires at API time, not at render time)
// ---------------------------------------------------------------------------
test('Release button remains enabled while pipeline is idle regardless of budget gate (gate fires at API time)', async ({
  page,
}) => {
  // No running jobs — isPipelineRunning=false, jobsPaused=false.
  // The release button must be enabled; the budget gate is invisible to the UI
  // until the POST is made. This verifies we have NOT added a premature client-
  // side disable for the budget gate.
  await stubCommonRoutes(page);

  // Do not mock the release endpoint — we only check button state here.
  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = page.getByRole('button', { name: /release/i }).first();
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).not.toBeDisabled();
  await expect(releaseBtn).not.toHaveAttribute('title', /paused globally/i);
  await expect(releaseBtn).not.toHaveAttribute('title', /budget/i);
});
