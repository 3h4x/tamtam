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

function runRow(page: import('@playwright/test').Page, project: string) {
  return page.getByRole('button').filter({ hasText: project }).first();
}

function runningRunRows(page: import('@playwright/test').Page) {
  return page.getByRole('button').filter({ has: page.locator('[aria-label="running"]') });
}

function statusFilterButton(
  page: import('@playwright/test').Page,
  label: 'running' | 'done' | 'failed',
) {
  return page.getByRole('button', { name: new RegExp(`^${label} \\d+$`) }).first();
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
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === project,
    (route: Route) => route.fulfill({ json: { items: [] } }),
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
    const row = page.getByRole('button').filter({ hasText: 'Test run' }).first();

    // Phase 1: the initial fetch returns "running" — verify the badge is visible.
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    // Flip the mock so the next poll (≤5 s away) will return "done".
    serveRunning = false;

    // Phase 2: wait for the auto-poll to fire and the UI to update.
    // Allow 12 s: one full 5 s poll cycle + rendering time + safety buffer.
    // No page.reload() — the polling loop must pick up the change.
    await expect(row.locator('[aria-label="done"]')).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history running filter clears when its only running job completes without reload', async ({
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
                'running-filter-clears-job',
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

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ has: page.locator('[aria-label="running"]') })
      .first();

    await expect(row).toBeVisible({ timeout: 8_000 });
    await statusFilterButton(page, 'running').click();
    await expect(row).toBeVisible();
    await expect(page.getByText('Nothing is running right now')).toHaveCount(0);

    serveRunning = false;

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    });
    await expect(
      page.getByText('This project has no active terminal, agent, or pipeline work at the moment.'),
    ).toBeVisible();
    await expect(row).toHaveCount(0);

    await page.getByRole('button', { name: /^all \d+$/ }).click();
    await expect(page.getByRole('button').filter({ hasText: 'test' }).first()).toBeVisible();
    await expect(page.getByText('done', { exact: true }).first()).toBeVisible();
  });

  test('history parent run updates nested release outcome from running to done without reload', async ({
    page,
  }) => {
    let serveReleaseRunning = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const releaseRunning = serveReleaseRunning;
        const ts = now();
        route.fulfill({
          json: {
            jobs: [
              {
                id: 'chat-owned-release-parent',
                project: PROJECT,
                kind: 'run',
                prompt: 'Ship the completed terminal work',
                user_prompt: 'Ship the completed terminal work',
                status: 'done',
                exit_code: 0,
                started_at: ts - 240,
                finished_at: ts - 220,
                pid: 0,
                log_path: '',
                seen: true,
                session_id: 'sess-owned-release',
                work_summary: 'Terminal work completed',
              },
              {
                id: 'chat-owned-release',
                project: PROJECT,
                kind: 'release',
                prompt: null,
                status: releaseRunning ? 'running' : 'done',
                exit_code: releaseRunning ? null : 0,
                started_at: ts - 200,
                finished_at: releaseRunning ? null : ts - 5,
                pid: 0,
                log_path: '',
                seen: true,
                parent_job_id: 'chat-owned-release-parent',
              },
              {
                id: 'chat-owned-release-review',
                project: PROJECT,
                kind: 'review',
                prompt: 'Review shipped work',
                status: releaseRunning ? 'running' : 'done',
                exit_code: releaseRunning ? null : 0,
                started_at: ts - 180,
                finished_at: releaseRunning ? null : ts - 20,
                pid: 0,
                log_path: '',
                seen: true,
                release_id: 'chat-owned-release',
                parent_job_id: 'chat-owned-release',
                verdict: releaseRunning ? null : 'LGTM',
              },
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    const ownerRow = page.getByRole('button')
      .filter({ hasText: 'Ship the completed terminal work' })
      .first();
    await expect(ownerRow).toBeVisible({ timeout: 8_000 });
    await expect(ownerRow.getByText('release running', { exact: true })).toBeVisible();
    await expect(ownerRow.getByLabel('running')).toBeVisible();

    serveReleaseRunning = false;

    await expect(ownerRow.getByText('✓ release done', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(ownerRow.getByText('release running', { exact: true })).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(ownerRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(ownerRow.locator('[aria-label="done"]')).toBeVisible();
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
    const row = page.getByRole('button').filter({ hasText: 'Test run' }).first();
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    // Flip mock so next poll returns the failed state.
    serveRunning = false;

    // Phase 2: polling picks up failure without a page reload.
    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history tab shows the failed job reason after a running job exits non-zero', async ({
    page,
  }) => {
    let serveRunning = true;
    const failureReason = 'Review failed because the release notes step timed out.';

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              {
                ...makeJob(
                  'fail-poll-reason-job',
                  PROJECT,
                  serveRunning ? 'running' : 'done',
                  serveRunning ? null : 1,
                  'test',
                ),
                work_summary: serveRunning ? 'Running release checks…' : failureReason,
              },
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button').filter({ hasText: 'Test run' }).first();
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    serveRunning = false;

    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(failureReason)).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
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
    const row = page.getByRole('button').filter({ hasText: 'Test run' }).first();
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    // Flip mock so the next poll delivers the cancelled state.
    serveRunning = false;

    // Phase 2: "cancelled" badge appears (exit_code=-3 maps to label "cancelled");
    // no spinner remains.
    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
  });
});

// ─── Test 2c: Pending release banner clears after poll ──────────────────────
//
// ProjectRunsTab also polls pendingReleaseProjects from /api/jobs. Verify the
// queued-release banner appears while the project is marked pending, then
// disappears on the next poll cycle without a page reload.

test.describe('Auto-polling live update: pending release banner', () => {
  test('history tab shows the queued release banner when pendingReleaseProjects gains the project', async ({
    page,
  }) => {
    let queued = false;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [],
            pendingReleaseProjects: queued ? [PROJECT] : [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    await expect(
      page.getByText(/Release queued — will fire automatically/i),
    ).toHaveCount(0, { timeout: 8_000 });

    queued = true;

    const banner = page.getByRole('link', {
      name: /Release queued — will fire automatically/i,
    });
    await expect(banner).toBeVisible({ timeout: 12_000 });
    await expect(banner).toHaveAttribute('href', `/pipeline?project=${PROJECT}`);
  });

  test('history tab clears the queued release banner when pendingReleaseProjects no longer includes the project', async ({
    page,
  }) => {
    let queued = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [],
            pendingReleaseProjects: queued ? [PROJECT] : [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    await expect(
      page.getByText(/Release queued — will fire automatically/i),
    ).toBeVisible({ timeout: 8_000 });

    queued = false;

    await expect(
      page.getByText(/Release queued — will fire automatically/i),
    ).not.toBeVisible({ timeout: 12_000 });
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
    await expect(runRow(page, ALPHA)).toBeVisible({ timeout: 8_000 });
    await expect(runRow(page, BETA)).toBeVisible({ timeout: 8_000 });

    // Count row-scoped running status icons, not filter/header text.
    await expect(runningRunRows(page)).toHaveCount(2, { timeout: 8_000 });

    // Clicking the "running" filter chip must keep both projects visible —
    // verifying that independent job state is preserved per project.
    await statusFilterButton(page, 'running').click();
    await expect(runRow(page, ALPHA)).toBeVisible();
    await expect(runRow(page, BETA)).toBeVisible();

    // The "done" filter chip must show 0 jobs — verified by the empty state message.
    await statusFilterButton(page, 'done').click();
    await expect(page.getByText('No completed runs in view')).toBeVisible();
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

    const alphaRow = runRow(page, ALPHA);
    const betaRow = runRow(page, BETA);

    await expect(alphaRow).toBeVisible({ timeout: 8_000 });
    await expect(betaRow).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(2, { timeout: 8_000 });

    alphaDone = true;

    await expect(alphaRow.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(betaRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(1, { timeout: 12_000 });

    await statusFilterButton(page, 'running').click();
    await expect(runRow(page, BETA)).toBeVisible();
    await expect(runRow(page, ALPHA)).toHaveCount(0);
  });
});

// ─── Test 3: Global runs page polling transitions ───────────────────────────
//
// The global /runs page polls /api/jobs every 5 s without a project filter.
// These tests verify that a single running job flips to its terminal state on
// the next poll cycle, with no page reload and no orphaned spinner.

test.describe('Global runs page polling transitions', () => {
  test('/runs page transitions running→done via poll cycle without page reload', async ({
    page,
  }) => {
    const project = 'runs-poll-done';
    let serveRunning = true;

    await page.route(
      (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'runs-poll-done-job',
                project,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : 0,
                'test',
              ),
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
          tasks: [makeTask(project)],
          priorities: [],
          issueCounts: {},
        },
      }),
    );

    await page.goto('/runs');

    const row = runRow(page, project);

    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(1, { timeout: 8_000 });

    serveRunning = false;

    await expect(row.getByText('done', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(0, { timeout: 12_000 });
  });

  test('/runs page transitions running→failed via poll cycle without page reload', async ({
    page,
  }) => {
    const project = 'runs-poll-failed';
    let serveRunning = true;

    await page.route(
      (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'runs-poll-failed-job',
                project,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : 1,
                'test',
              ),
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
          tasks: [makeTask(project)],
          priorities: [],
          issueCounts: {},
        },
      }),
    );

    await page.goto('/runs');

    const row = runRow(page, project);

    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(1, { timeout: 8_000 });

    serveRunning = false;

    await expect(row.locator('[aria-label="needs attention"]')).toBeVisible({
      timeout: 12_000,
    });
    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(0, { timeout: 12_000 });
  });

  test('/runs page shows the failure reason text after a running job fails without reload', async ({
    page,
  }) => {
    const project = 'runs-poll-failed-reason';
    let serveRunning = true;
    const failureReason = 'Push failed because the remote hook rejected the branch.';

    await page.route(
      (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              {
                ...makeJob(
                  'runs-poll-failed-reason-job',
                  project,
                  serveRunning ? 'running' : 'done',
                  serveRunning ? null : 1,
                  'push',
                ),
                work_summary: serveRunning ? 'Pushing branch to remote…' : failureReason,
              },
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
          tasks: [makeTask(project)],
          priorities: [],
          issueCounts: {},
        },
      }),
    );

    await page.goto('/runs');

    const row = runRow(page, project);

    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    serveRunning = false;

    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(failureReason)).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
  });

  test('/runs page reveals failed filter after a running job fails without reload', async ({
    page,
  }) => {
    const project = 'runs-poll-failed-filter';
    let serveRunning = true;

    await page.route(
      (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'runs-poll-failed-filter-job',
                project,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : 1,
                'test',
              ),
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
          tasks: [makeTask(project)],
          priorities: [],
          issueCounts: {},
        },
      }),
    );

    await page.goto('/runs');

    const row = runRow(page, project);

    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(statusFilterButton(page, 'running')).toBeVisible();
    await expect(statusFilterButton(page, 'failed')).toHaveCount(0);

    serveRunning = false;

    const failedFilter = statusFilterButton(page, 'failed');
    await expect(failedFilter).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });

    await failedFilter.click();
    await expect(row).toBeVisible();
    await expect(statusFilterButton(page, 'running')).toHaveCount(0);
    await expect(row.locator('[aria-label="needs attention"]')).toBeVisible();
  });

  test('/runs page transitions running→cancelled via poll cycle without page reload', async ({
    page,
  }) => {
    const project = 'runs-poll-cancelled';
    let serveRunning = true;

    await page.route(
      (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'runs-poll-cancelled-job',
                project,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : -3,
                'test',
              ),
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
          tasks: [makeTask(project)],
          priorities: [],
          issueCounts: {},
        },
      }),
    );

    await page.goto('/runs');

    const row = runRow(page, project);

    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(1, { timeout: 8_000 });

    serveRunning = false;

    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(0, { timeout: 12_000 });
  });
});
