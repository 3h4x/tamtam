import { test, expect, Route } from '@playwright/test';

// E2E coverage for the *exit paths* of the diverged-pull warning in the project
// header (components/project-detail/ProjectActions.tsx, the `pullDiverged`
// branch). pull-flow.spec.ts already verifies the warning APPEARS with
// Rebase/Merge buttons after a 409 diverged response; the gaps here are the two
// ways the warning is dismissed:
//
//   1. Dismiss (✕) — onDismissDiverged clears pullDiverged, the Diverged strip
//      disappears and the plain Pull button returns. No POST is sent.
//   2. Resolve via Rebase — a second POST with strategy="rebase" succeeds, the
//      warning clears, the plain Pull button returns, and the "Pulled." success
//      result is shown.
//
// All HTTP calls are mocked — no real git invocations and no global-setup
// project registration.

const PROJECT = 'diverged-pull-resolution-ui';

interface PullCall {
  strategy: string;
}

interface MockOpts {
  // First pull (ff-only) returns 409 diverged; subsequent strategies resolve.
  onPull?: (call: PullCall) => void;
  resolveOutput?: string;
}

async function mockRoutes(page: import('@playwright/test').Page, opts: MockOpts = {}) {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [{
          project: PROJECT,
          path: `/tmp/${PROJECT}`,
          github: null,
          priority: null,
          changes: 0,
          reviewed: false,
          unpushed: 0,
          last_run_ago: null,
          release_tag: null,
        }],
      },
    }),
  );
  await page.route('**/api/jobs**', (route: Route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({
      json: {
        project: PROJECT, test_command: '', detected_test_command: '',
        effective_test_command: '', test_cron_enabled: false,
        test_cron_schedule: '', auto_push_enabled: false,
        last_push_error: null, last_push_at: null,
      },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 1, ahead: 1 } }),
  );

  await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = (route.request().postDataJSON() ?? {}) as { strategy?: string };
      const strategy = body.strategy ?? 'ff-only';
      opts.onPull?.({ strategy });
      // The ff-only attempt diverges; an explicit rebase/merge resolves it.
      if (strategy === 'ff-only') {
        return route.fulfill({ status: 409, json: { detail: 'diverged', diverged: true } });
      }
      return route.fulfill({
        status: 200,
        json: { status: 'ok', output: opts.resolveOutput ?? 'Updated 1 file.' },
      });
    }
    route.fulfill({
      json: {
        files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0,
        branch: 'master', behind: 1, ahead: 1,
      },
    });
  });

  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

// ---------------------------------------------------------------------------
// Test 1: Dismiss restores the plain Pull button and sends no POST
// ---------------------------------------------------------------------------
test('Dismiss (✕) clears the diverged warning and restores the plain Pull button without a second POST', async ({
  page,
}) => {
  const calls: PullCall[] = [];
  await mockRoutes(page, { onPull: (c) => calls.push(c) });
  await page.goto(`/project/${PROJECT}`);

  // Trigger the diverged warning.
  await page.getByRole('button', { name: /pull/i }).first().click();

  const dismiss = page.getByRole('button', { name: 'Dismiss diverged warning' });
  await expect(dismiss).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('Diverged:')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Rebase$/ })).toBeVisible();

  // Dismiss it.
  await dismiss.click();

  // The Diverged strip is gone and the plain Pull button is back.
  await expect(page.getByText('Diverged:')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dismiss diverged warning' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /pull/i }).first()).toBeVisible();

  // Only the original ff-only attempt was sent; dismiss is a pure client action.
  expect(calls).toHaveLength(1);
  expect(calls[0].strategy).toBe('ff-only');
});

// ---------------------------------------------------------------------------
// Test 2: Rebase resolves — sends strategy=rebase, clears warning, shows success
// ---------------------------------------------------------------------------
test('Rebase resolves the diverged state: POSTs strategy=rebase, clears the warning, and shows the "Pulled." result', async ({
  page,
}) => {
  const calls: PullCall[] = [];
  await mockRoutes(page, { onPull: (c) => calls.push(c) });
  await page.goto(`/project/${PROJECT}`);

  await page.getByRole('button', { name: /pull/i }).first().click();

  const rebase = page.getByRole('button', { name: /^Rebase$/ });
  await expect(rebase).toBeVisible({ timeout: 8_000 });
  await rebase.click();

  // Success result is surfaced and the diverged strip clears.
  await expect(page.getByText('Pulled.')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('Diverged:')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /pull/i }).first()).toBeVisible();

  // The ff-only attempt diverged, then an explicit rebase was sent.
  expect(calls.map((c) => c.strategy)).toEqual(['ff-only', 'rebase']);
});
