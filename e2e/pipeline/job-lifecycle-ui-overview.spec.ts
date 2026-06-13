import { test, expect } from '@playwright/test';
import { PROJECT, mockJobScenario, makeJob, now, type MockJob } from './job-lifecycle-ui-fixtures';

test.describe('Job lifecycle UI badges', () => {
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

  test('overview tab clears active-work banner when running job transitions to failed via poll', async ({
    page,
  }) => {
    let serveRunning = true;
    await mockJobScenario(page, () => [
      makeJob({
        id: 'job-live-overview-failure',
        kind: 'test',
        status: serveRunning ? 'running' : 'done',
        exit_code: serveRunning ? null : 1,
        started_at: now() - 30,
        finished_at: serveRunning ? null : now() - 5,
        session_id: 'sess-live-overview-failure',
        work_summary: serveRunning
          ? 'Tests are still running before failure'
          : 'Tests failed after the smoke check timed out.',
      }),
    ]);

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('1 running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('test').first()).toBeVisible();

    serveRunning = false;

    await expect(page.getByText('1 running now')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('active work')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('Tests are still running before failure')).toHaveCount(0);
  });
});
