import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Live-update UI tests — verify auto-polling state transitions and concurrent
// multi-project job visibility without page reload.
//
// Uses page.route() to intercept API calls; no real pipeline execution is
// involved (no Claude shim, no git shim, no PM2 jobs).

const PROJECT = 'lifecycle-ui'; // reuse the mocked-API project from job-lifecycle-ui.spec.ts

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
  project: string,
  status: 'running' | 'done',
  exit_code: number | null,
  kind = 'review',
) {
  return {
    id,
    project,
    kind,
    status,
    exit_code,
    started_at: now() - 60,
    finished_at: status === 'done' ? now() - 5 : null,
    pid: 0,
    log_path: '',
    seen: true,
  };
}

async function stubCommonRoutes(
  page: import('@playwright/test').Page,
  project: string,
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(project)], priorities: [], issueCounts: {} },
    }),
  );
  await page.route(
    `**/api/projects/by-project/${project}/config`,
    (route: Route) =>
      route.fulfill({
        json: {
          project,
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
  await page.route(
    `**/api/projects/by-project/${project}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
  );
  await page.route(
    `**/api/agents?project=${project}`,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${project}/branch`,
    (route: Route) =>
      route.fulfill({
        json: { branch: 'master', defaultBranch: 'master', commitsAhead: null },
      }),
  );
  await page.route(
    `**/api/projects/by-project/${project}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    `**/api/projects/by-project/${project}/issues`,
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
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
}

// ─── Test 1: Auto-polling live update ────────────────────────────────────────
//
// ProjectRunsTab (history tab) polls /api/jobs every 5 s.
// This test verifies the UI transitions from "running" to "done" on the
// next poll cycle — no page.reload() allowed.

test.describe('Auto-polling live update', () => {
  test('history tab transitions running→done via 5s poll cycle without page reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubCommonRoutes(page, PROJECT);

    // Dynamic mock: first calls return "running", subsequent calls return "done".
    // The closure variable is flipped after the page renders the initial state.
    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              // Use kind:'test' — review jobs with no verdict render "review verdict missing"
              // instead of "done", which would break the Phase 2 assertion.
              makeJob(
                'auto-poll-job',
                PROJECT,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : 0,
                'test',
              ),
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Phase 1: the initial fetch returns "running" — verify the badge is visible.
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });

    // Flip the mock so the next poll (≤5 s away) will return "done".
    serveRunning = false;

    // Phase 2: wait for the auto-poll to fire and the UI to update.
    // Allow 12 s: one full 5 s poll cycle + rendering time + safety buffer.
    // No page.reload() — the polling loop must pick up the change.
    await expect(page.getByText('done').first()).toBeVisible({ timeout: 12_000 });

    // No orphaned spinner: the status badge with exactly "running" text must be gone.
    // Using { exact: true } to avoid matching the persistent "jobs running" header toggle.
    await expect(page.getByText('running', { exact: true })).not.toBeVisible();
  });
});

// ─── Test 2a: Live running → failed transition ───────────────────────────────
//
// Mirrors the running→done test above but for the failure case.
// Verifies that when a running job transitions to done with exit_code=1 the UI
// shows the "exit 1" failure badge on the next poll cycle, with no spinner left.

test.describe('Auto-polling live update: running → failed', () => {
  test('history tab transitions running→exit 1 via 5s poll cycle without page reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'fail-poll-job',
                PROJECT,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : 1,
                'test',
              ),
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Phase 1: job is running — confirm badge is visible.
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });

    // Flip mock so next poll returns the failed state.
    serveRunning = false;

    // Phase 2: polling picks up failure without a page reload.
    await expect(page.getByText('exit 1').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible();
  });
});

// ─── Test 2b: Live running → cancelled transition ────────────────────────────
//
// Verifies that a running job that transitions to done with exit_code=-3
// (aborted pipeline) shows the "cancelled" badge on the next poll cycle,
// with no orphaned spinner remaining.
// RunRow maps exit_code=-3 to the "cancelled" label via statusFailureLabel.

test.describe('Auto-polling live update: running → cancelled', () => {
  test('history tab transitions running→cancelled via 5s poll cycle without page reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'cancel-poll-job',
                PROJECT,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : -3,
                'test',
              ),
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Phase 1: running badge visible initially.
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });

    // Flip mock so the next poll delivers the cancelled state.
    serveRunning = false;

    // Phase 2: "cancelled" badge appears (exit_code=-3 maps to label "cancelled");
    // no spinner remains.
    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible();
  });
});

// ─── Test 2: Concurrent jobs across projects ─────────────────────────────────
//
// The global /runs page fetches /api/jobs without a project filter and renders
// all jobs from all projects in a single table. Verify that two simultaneously
// running jobs from different projects each display correctly and that the
// "running" filter shows both independently.

test.describe('Concurrent jobs across projects', () => {
  test('/runs page shows independent running jobs for two projects simultaneously', async ({
    page,
  }) => {
    const ALPHA = 'alpha-project';
    const BETA = 'beta-project';

    const alphaJob = makeJob('job-alpha', ALPHA, 'running', null, 'review');
    const betaJob = makeJob('job-beta', BETA, 'running', null, 'test');

    // Mock the global /api/jobs endpoint (no project query param).
    // JobsPage calls fetchJobs() without a project, which generates /api/jobs?limit=50.
    await page.route(
      (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
      (route: Route) =>
        route.fulfill({
          json: { jobs: [alphaJob, betaJob], pendingReleaseProjects: [] },
        }),
    );

    // App-shell routes common to every page load.
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({ json: { notifications: [] } }),
    );
    await page.route('**/api/settings', (route: Route) =>
      route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
    );
    await page.route('**/api/projects', (route: Route) =>
      route.fulfill({
        json: {
          tasks: [makeTask(ALPHA), makeTask(BETA)],
          priorities: [],
          issueCounts: {},
        },
      }),
    );

    await page.goto('/runs');

    // Both project names must be visible in the job list.
    await expect(page.getByText(ALPHA).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(BETA).first()).toBeVisible({ timeout: 8_000 });

    // The job list uses div-based cards (not table rows). Each running job card
    // renders an animate-pulse dot (●) inside the status badge — count those
    // to verify exactly 2 independent running jobs are visible.
    const runningDots = page.locator('span.animate-pulse');
    await expect(runningDots).toHaveCount(2, { timeout: 8_000 });

    // Clicking the "running" filter chip must keep both projects visible —
    // verifying that independent job state is preserved per project.
    await page.getByRole('button', { name: /^running/ }).click();
    await expect(page.getByText(ALPHA).first()).toBeVisible();
    await expect(page.getByText(BETA).first()).toBeVisible();

    // The "done" filter chip must show 0 jobs — verified by the empty state message.
    await page.getByRole('button', { name: /^done/ }).click();
    await expect(page.getByText(/no done runs/i)).toBeVisible();
  });

  test('/runs page keeps concurrent job transitions isolated when one job finishes and the other keeps running', async ({
    page,
  }) => {
    const ALPHA = 'alpha-project';
    const BETA = 'beta-project';
    let alphaDone = false;

    await page.route(
      (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob('job-alpha', ALPHA, alphaDone ? 'done' : 'running', alphaDone ? 0 : null, 'review'),
              makeJob('job-beta', BETA, 'running', null, 'test'),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({ json: { notifications: [] } }),
    );
    await page.route('**/api/settings', (route: Route) =>
      route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
    );
    await page.route('**/api/projects', (route: Route) =>
      route.fulfill({
        json: {
          tasks: [makeTask(ALPHA), makeTask(BETA)],
          priorities: [],
          issueCounts: {},
        },
      }),
    );

    await page.goto('/runs');

    await expect(page.getByText(ALPHA).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(BETA).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(2, { timeout: 8_000 });

    alphaDone = true;

    await expect(page.locator('span.animate-pulse')).toHaveCount(1, { timeout: 12_000 });

    await page.getByRole('button', { name: /^running/ }).click();
    await expect(page.getByText(BETA).first()).toBeVisible();
    await expect(page.getByText(ALPHA).first()).not.toBeVisible();

    await page.getByRole('button', { name: /^done/ }).click();
    await expect(page.getByText(ALPHA).first()).toBeVisible();
    await expect(page.getByText(BETA).first()).not.toBeVisible();
  });
});
