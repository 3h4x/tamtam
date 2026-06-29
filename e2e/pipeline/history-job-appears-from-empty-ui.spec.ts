import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';
import { PROJECT, makeJob, now, stubCommonRoutes } from './live-update-ui-fixtures';

// Mocked-API test for the "job starts → spinner shows in runs list" transition.
//
// The existing live-update-ui-history.spec.ts tests start with a running job
// already in the response. This spec covers the distinct gap: history tab is
// open with NO jobs, then a new running job appears on the next poll cycle —
// the spinner must appear without a page reload.

test.describe('History tab — new job appears from empty state', () => {
  test('history tab adds a running spinner when a job first appears via poll on an empty list', async ({
    page,
  }) => {
    let serveJob = false;

    await stubCommonRoutes(page, PROJECT);

    // Start with no jobs; flip to a running job after the page loads.
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: serveJob
              ? [
                  makeJob(
                    'appears-from-empty-1',
                    PROJECT,
                    'running',
                    null,
                    'test',
                    { startedAt: now() - 5 },
                  ),
                ]
              : [],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Phase 1: empty state — no running spinner should be present.
    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('[aria-label="running"]')).toHaveCount(0);

    // Flip the mock so the next poll returns the new running job.
    serveJob = true;

    // Phase 2: wait for the auto-poll to pick up the new job and render its spinner.
    // Allow 12 s: one 5 s poll cycle + rendering time + safety buffer.
    // No page.reload() — the polling loop must discover and add the row.
    await expect(page.locator('[aria-label="running"]').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('No runs yet')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history tab shows running badge and kind label for a job that appears via poll', async ({
    page,
  }) => {
    let serveJob = false;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: serveJob
              ? [
                  makeJob(
                    'appears-with-kind-1',
                    PROJECT,
                    'running',
                    null,
                    'test',
                    { startedAt: now() - 10 },
                  ),
                ]
              : [],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 8_000 });

    serveJob = true;

    // The row must show both the "running" badge and the kind label.
    const row = page.getByRole('button').filter({ has: page.locator('[aria-label="running"]') }).first();
    await expect(row).toBeVisible({ timeout: 12_000 });
    await expect(row).toContainText('test');
    await expect(row.locator('[aria-label="running"]')).toBeVisible();
  });
});
