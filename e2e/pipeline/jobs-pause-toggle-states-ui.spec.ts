import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Mocked-API UI tests for JobsPauseToggle header chip states.
// Covers: rebuild_in_progress, manual-paused, scheduled-paused (budget throttle),
// and jobs-running. Routes are relative, so requests hit the configured baseURL; no real pipeline.

async function stubShellRoutes(
  page: import('@playwright/test').Page,
  settingsOverride: Record<string, string> = {},
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
    (route: Route) =>
      route.fulfill({
        json: {
          runs: [],
          meta: { workflowEnabled: true, releaseWorkflow: true, releaseWorkflowDrive: true, mode: 'drive' },
        },
      }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/usage/quota', (route: Route) =>
    route.fulfill({
      json: { gateEnabled: false, fiveHour: { utilization: 0, resetsAt: null, msUntilReset: null }, sevenDay: { utilization: 0, resetsAt: null, msUntilReset: null } },
    }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: 'false', rebuild_in_progress: 'false', ...settingsOverride },
        github_owner: '',
      },
    }),
  );
}

test.describe('JobsPauseToggle chip states', () => {
  // -----------------------------------------------------------------------
  // State 1: jobs running (default)
  // -----------------------------------------------------------------------
  test('shows "jobs running" chip by default', async ({ page }) => {
    await stubShellRoutes(page);

    await page.goto('/workflow-runs');

    const toggle = page.getByRole('switch');
    await expect(toggle).toBeVisible({ timeout: 8_000 });
    await expect(toggle).toHaveText('jobs running');
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  // -----------------------------------------------------------------------
  // State 2: jobs paused (manual)
  // -----------------------------------------------------------------------
  test('shows "jobs paused" chip when jobs_paused=true', async ({ page }) => {
    await stubShellRoutes(page, { jobs_paused: 'true' });

    await page.goto('/workflow-runs');

    const toggle = page.getByRole('switch');
    await expect(toggle).toBeVisible({ timeout: 8_000 });
    await expect(toggle).toHaveText('jobs paused');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toBeEnabled();
  });

  // -----------------------------------------------------------------------
  // State 3: rebuild in progress — chip disabled, shows "rebuilding…"
  // -----------------------------------------------------------------------
  test('shows "rebuilding…" chip and disables it when rebuild_in_progress=true', async ({ page }) => {
    await stubShellRoutes(page, { rebuild_in_progress: 'true' });

    await page.goto('/workflow-runs');

    const toggle = page.getByRole('switch');
    await expect(toggle).toBeVisible({ timeout: 8_000 });
    await expect(toggle).toHaveText(/rebuilding/i);
    await expect(toggle).toBeDisabled();
    // A spinner element (role=status) should be visible inside the chip
    await expect(toggle.locator('[role=status]')).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // State 4: scheduled paused (budget throttle active)
  // -----------------------------------------------------------------------
  test('shows "scheduled paused" chip when budget throttle is active', async ({ page }) => {
    const resumesAtMs = Date.now() + 60 * 60 * 1000; // 1h from now
    await stubShellRoutes(page, { budget_block_runs_enabled: 'true' });
    // Override /api/usage/quota to report an active throttle
    await page.route('**/api/usage/quota', (route: Route) =>
      route.fulfill({
        json: {
          gateEnabled: true,
          fiveHour: { utilization: 0.3, resetsAt: null, msUntilReset: null },
          sevenDay: { utilization: 0.95, resetsAt: null, msUntilReset: null },
          schedulerThrottle: {
            reason: 'weekly budget exceeded',
            projectedPct: 110,
            worstProvider: 'claude',
            resumesAtMs,
          },
        },
      }),
    );

    await page.goto('/workflow-runs');

    const toggle = page.getByRole('switch');
    await expect(toggle).toBeVisible({ timeout: 8_000 });
    await expect(toggle).toHaveText('scheduled paused');
    // The chip is still clickable (manual pause still works)
    await expect(toggle).toBeEnabled();
  });

  // -----------------------------------------------------------------------
  // State 5: rebuild_in_progress clears on next poll → chip re-enables
  // -----------------------------------------------------------------------
  test('"rebuilding…" chip re-enables when rebuild_in_progress flips to false on poll', async ({ page }) => {
    let rebuildInProgress = true;

    await stubShellRoutes(page);
    // Dynamic settings mock — flips rebuild_in_progress on demand
    await page.route('**/api/settings', (route: Route) =>
      route.fulfill({
        json: {
          settings: {
            jobs_paused: 'false',
            rebuild_in_progress: rebuildInProgress ? 'true' : 'false',
          },
          github_owner: '',
        },
      }),
    );

    await page.goto('/workflow-runs');

    const toggle = page.getByRole('switch');
    await expect(toggle).toBeVisible({ timeout: 8_000 });
    await expect(toggle).toHaveText(/rebuilding/i);
    await expect(toggle).toBeDisabled();

    // Flip the flag so next poll clears it
    rebuildInProgress = false;

    // JobsPauseToggle polls every 5s — wait up to 12s for the chip to re-enable
    await expect(toggle).toHaveText('jobs running', { timeout: 12_000 });
    await expect(toggle).toBeEnabled();
  });

  // -----------------------------------------------------------------------
  // State 6: clicking "jobs running" → optimistically flips to "jobs paused"
  // -----------------------------------------------------------------------
  test('clicking "jobs running" toggle optimistically shows "jobs paused"', async ({ page }) => {
    let jobsPaused = false;

    await stubShellRoutes(page);
    await page.route('**/api/settings', async (route: Route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON() as { jobs_paused?: string };
        jobsPaused = body.jobs_paused === 'true';
        await route.fulfill({
          json: {
            settings: { jobs_paused: jobsPaused ? 'true' : 'false', rebuild_in_progress: 'false' },
            github_owner: '',
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          settings: { jobs_paused: jobsPaused ? 'true' : 'false', rebuild_in_progress: 'false' },
          github_owner: '',
        },
      });
    });

    await page.goto('/workflow-runs');

    const toggle = page.getByRole('switch');
    await expect(toggle).toBeVisible({ timeout: 8_000 });
    await expect(toggle).toHaveText('jobs running');

    await toggle.click();

    // Optimistic update — chip flips immediately without waiting for poll
    await expect(toggle).toHaveText('jobs paused', { timeout: 3_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});
