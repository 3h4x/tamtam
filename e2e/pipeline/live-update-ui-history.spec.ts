import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';
import { PROJECT, makeJob, now, statusFilterButton, stubCommonRoutes } from './live-update-ui-fixtures';

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

// ─── Test 1b: New job appears in history from zero-jobs state ────────────────
//
// All existing "live update" tests start with the job already present when the
// page loads. This test verifies the history tab picks up a brand-new running
// job on the next poll cycle starting from an empty state — the "job starts
// while you are already on the page" path.

test.describe('Auto-polling live update: new job appears from empty state', () => {
  test('history tab renders a new running job row when none existed on load', async ({ page }) => {
    let jobExists = false;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: jobExists
              ? [makeJob('new-job-appears', PROJECT, 'running', null, 'test')]
              : [],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Confirm the history is truly empty on page load (ProjectRunsEmptyState mode:'empty').
    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button').filter({ hasText: 'Test run' })).toHaveCount(0);

    // New job starts — flip the mock so the next 5 s poll delivers it.
    jobExists = true;

    // The history tab must pick up the new row without a page reload.
    const row = page.getByRole('button').filter({ hasText: 'Test run' }).first();
    await expect(row).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });

    // Empty-state message must disappear once the job appears.
    await expect(page.getByText('No runs yet')).toHaveCount(0);
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

  test('history tab transitions a running review to "review verdict missing" without reload', async ({
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
              {
                ...makeJob(
                  'review-verdict-missing-job',
                  PROJECT,
                  serveRunning ? 'running' : 'done',
                  serveRunning ? null : 0,
                  'review',
                ),
                work_summary: serveRunning
                  ? 'Review is still running.'
                  : 'Review finished without writing a formal verdict line.',
              },
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button').filter({ hasText: 'Code review' }).first();
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    serveRunning = false;

    await expect(row.getByText('review verdict missing', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(row.getByText('Review finished without writing a formal verdict line.')).toBeVisible({
      timeout: 12_000,
    });
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
