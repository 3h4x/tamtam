import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Initiatives page UI tests — stat cards, flag badges, empty/non-empty backlog,
// promote/reject/restore actions, and preview-mining flow.
// All tests use page.route() mocking against port 1338; no real data writes.

const now = () => Date.now();

type InitiativeRow = {
  id: number;
  project: string;
  source: string;
  kind: string;
  title: string;
  rationale: string;
  score: number;
  status: string;
  releaseId: string | null;
  pinnedAt: number | null;
  updatedAt: number;
};

function makeInitiative(overrides: Partial<InitiativeRow> = {}): InitiativeRow {
  return {
    id: 1,
    project: 'my-project',
    source: 'probe:todo',
    kind: 'todo',
    title: 'Fix TODO in handlers',
    rationale: 'Found a TODO comment that needs addressing.',
    score: 72,
    status: 'proposed',
    releaseId: null,
    pinnedAt: null,
    updatedAt: now() - 60_000,
    ...overrides,
  };
}

function makeInitiativesResponse(
  initiatives: InitiativeRow[] = [],
  overrides: {
    engineEnabled?: boolean;
    miningEnabled?: boolean;
    proposed?: number;
    queued?: number;
    running?: number;
    shipped?: number;
    failed?: number;
  } = {},
) {
  return {
    generatedAt: now(),
    flags: {
      engineEnabled: overrides.engineEnabled ?? true,
      miningEnabled: overrides.miningEnabled ?? true,
      maxShipsPerDay: 3,
      maxBacklogPerProject: 10,
    },
    counts: {
      proposed: overrides.proposed ?? initiatives.filter((i) => i.status === 'proposed').length,
      queued: overrides.queued ?? initiatives.filter((i) => i.status === 'queued').length,
      running: overrides.running ?? 0,
      shipped: overrides.shipped ?? 0,
      failed: overrides.failed ?? 0,
      rejected: initiatives.filter((i) => i.status === 'rejected').length,
      superseded: 0,
    },
    initiatives,
  };
}

async function stubShellRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  // Return empty projects so preview section renders no rows (avoids spurious requests)
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  // Stub recommendations tab data so switching to Initiatives doesn't fetch these
  await page.route(
    (url) => url.pathname === '/api/recommendations',
    (route: Route) => route.fulfill({ json: { recommendations: [] } }),
  );
}

test.describe('Initiatives page — stat cards and flags', () => {
  test('renders count stat cards from API response', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({
        json: makeInitiativesResponse([], {
          proposed: 4,
          queued: 2,
          running: 1,
          shipped: 7,
          failed: 0,
        }),
      }),
    );

    await page.goto('/recommendations?tab=initiatives');

    // Wait for page to load
    await expect(page.getByText('Proposed')).toBeVisible({ timeout: 8_000 });

    // Stat card labels — use exact:true to avoid matching the "jobs running" nav button
    await expect(page.getByText('Queued', { exact: true })).toBeVisible();
    await expect(page.getByText('Running', { exact: true })).toBeVisible();
    await expect(page.getByText('Shipped', { exact: true })).toBeVisible();
    await expect(page.getByText('Failed', { exact: true })).toBeVisible();
  });

  test('shows Engine on and Mining on flag badges when both enabled', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({
        json: makeInitiativesResponse([], { engineEnabled: true, miningEnabled: true }),
      }),
    );

    await page.goto('/recommendations?tab=initiatives');

    await expect(page.getByText('Engine on')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Mining on')).toBeVisible();
  });

  test('shows engine-off warning when engine is disabled', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({
        json: makeInitiativesResponse([], { engineEnabled: false, miningEnabled: false }),
      }),
    );

    await page.goto('/recommendations?tab=initiatives');

    // When engine is disabled the warning text with Settings link appears
    await expect(page.getByText(/Engine is off/)).toBeVisible({ timeout: 8_000 });
  });
});

test.describe('Initiatives page — backlog', () => {
  test('shows empty state when backlog is empty', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({ json: makeInitiativesResponse([]) }),
    );

    await page.goto('/recommendations?tab=initiatives');

    await expect(
      page.getByText('Nothing in the backlog yet — the engine is off or nothing mined.'),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('renders backlog items grouped by project with kind badges and titles', async ({ page }) => {
    const rows = [
      makeInitiative({ id: 1, project: 'alpha', title: 'Fix alpha TODO', kind: 'todo', score: 80 }),
      makeInitiative({ id: 2, project: 'alpha', title: 'Fix alpha FIXME', kind: 'fixme', score: 60 }),
      makeInitiative({ id: 3, project: 'beta', title: 'Fix beta lint', kind: 'lint', score: 50 }),
    ];

    await stubShellRoutes(page);
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({ json: makeInitiativesResponse(rows) }),
    );

    await page.goto('/recommendations?tab=initiatives');

    // Wait for data to render
    await expect(page.getByText('Fix alpha TODO')).toBeVisible({ timeout: 8_000 });

    // Both project group names visible via their data-private span headers
    await expect(page.locator('[data-private]', { hasText: 'alpha' }).first()).toBeVisible();
    await expect(page.locator('[data-private]', { hasText: 'beta' }).first()).toBeVisible();

    // All item titles visible
    await expect(page.getByText('Fix alpha FIXME')).toBeVisible();
    await expect(page.getByText('Fix beta lint')).toBeVisible();

    // Kind badges visible (font-mono badge spans)
    await expect(page.getByText('fixme').first()).toBeVisible();
    await expect(page.getByText('lint').first()).toBeVisible();
  });

  test('proposed and queued items show Promote and Reject buttons', async ({ page }) => {
    const rows = [
      makeInitiative({ id: 1, status: 'proposed', title: 'A proposed initiative' }),
      makeInitiative({ id: 2, status: 'queued', title: 'A queued initiative' }),
    ];

    await stubShellRoutes(page);
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({ json: makeInitiativesResponse(rows) }),
    );

    await page.goto('/recommendations?tab=initiatives');

    await expect(page.getByText('A proposed initiative')).toBeVisible({ timeout: 8_000 });

    // Promote (👍) and Reject (👎) buttons appear for curatable rows
    const promoteButtons = page.getByRole('button', { name: 'Promote' });
    const rejectButtons = page.getByRole('button', { name: 'Reject' });
    await expect(promoteButtons).toHaveCount(2);
    await expect(rejectButtons).toHaveCount(2);
  });

  test('terminal status rows (running/shipped/failed) show no action buttons', async ({
    page,
  }) => {
    const rows = [
      makeInitiative({ id: 1, status: 'running', title: 'Running initiative' }),
      makeInitiative({ id: 2, status: 'shipped', title: 'Shipped initiative' }),
      makeInitiative({ id: 3, status: 'failed', title: 'Failed initiative' }),
    ];

    await stubShellRoutes(page);
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({ json: makeInitiativesResponse(rows) }),
    );

    await page.goto('/recommendations?tab=initiatives');

    await expect(page.getByText('Running initiative')).toBeVisible({ timeout: 8_000 });

    // No Promote or Reject buttons for terminal rows
    await expect(page.getByRole('button', { name: 'Promote' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  });
});

test.describe('Initiatives page — promote/reject/restore actions', () => {
  test('Promote fires PATCH with action=promote and list refreshes showing pin indicator', async ({
    page,
  }) => {
    const unpinned = makeInitiative({ id: 5, status: 'proposed', title: 'Promote me', pinnedAt: null });
    const pinned = { ...unpinned, pinnedAt: now() };

    // Use a flag (not a counter) so React StrictMode double-invoke doesn't
    // switch the response before the user has a chance to click Promote.
    let promotePatchFired = false;
    let patchBody: unknown = null;

    await stubShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/initiatives',
      (route: Route) => {
        const initiative = promotePatchFired ? pinned : unpinned;
        route.fulfill({ json: makeInitiativesResponse([initiative]) });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/initiatives/5',
      (route: Route) => {
        if (route.request().method() === 'PATCH') {
          promotePatchFired = true;
          patchBody = route.request().postDataJSON();
          route.fulfill({ json: { ok: true } });
        } else {
          route.continue();
        }
      },
    );

    await page.goto('/recommendations?tab=initiatives');
    await expect(page.getByText('Promote me')).toBeVisible({ timeout: 8_000 });
    // Initially no pin indicator and Promote button is present
    await expect(page.locator('[aria-label="pinned"]')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Promote' })).toBeVisible();

    await page.getByRole('button', { name: 'Promote' }).click();

    // PATCH fires with correct action
    await expect.poll(() => patchBody, { timeout: 6_000 }).toEqual({ action: 'promote' });

    // List refreshes and pin indicator appears (📌 span)
    await expect(page.locator('[aria-label="pinned"]')).toBeVisible({ timeout: 8_000 });

    // Promote button now shows "Un-pin" after refresh
    await expect(page.getByRole('button', { name: 'Un-pin' })).toBeVisible();
  });

  test('Reject fires PATCH with action=reject; row then shows undo button', async ({ page }) => {
    const proposed = makeInitiative({ id: 6, status: 'proposed', title: 'Reject me' });
    const rejected = { ...proposed, status: 'rejected' };

    let rejectPatchFired = false;
    let patchBody: unknown = null;

    await stubShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/initiatives',
      (route: Route) => {
        route.fulfill({ json: makeInitiativesResponse([rejectPatchFired ? rejected : proposed]) });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/initiatives/6',
      (route: Route) => {
        if (route.request().method() === 'PATCH') {
          rejectPatchFired = true;
          patchBody = route.request().postDataJSON();
          route.fulfill({ json: { ok: true } });
        } else {
          route.continue();
        }
      },
    );

    await page.goto('/recommendations?tab=initiatives');
    await expect(page.getByText('Reject me')).toBeVisible({ timeout: 8_000 });

    await page.getByRole('button', { name: 'Reject' }).click();

    await expect.poll(() => patchBody, { timeout: 6_000 }).toEqual({ action: 'reject' });

    // After refresh: rejected status text shows and undo replaces promote/reject
    await expect(page.getByText('rejected')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'undo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Promote' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  });

  test('Restore (undo) fires PATCH with action=restore; row becomes queued', async ({ page }) => {
    const rejected = makeInitiative({ id: 7, status: 'rejected', title: 'Restore me' });
    const restored = { ...rejected, status: 'queued' };

    let restorePatchFired = false;
    let patchBody: unknown = null;

    await stubShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/initiatives',
      (route: Route) => {
        route.fulfill({ json: makeInitiativesResponse([restorePatchFired ? restored : rejected]) });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/initiatives/7',
      (route: Route) => {
        if (route.request().method() === 'PATCH') {
          restorePatchFired = true;
          patchBody = route.request().postDataJSON();
          route.fulfill({ json: { ok: true } });
        } else {
          route.continue();
        }
      },
    );

    await page.goto('/recommendations?tab=initiatives');
    await expect(page.getByText('Restore me')).toBeVisible({ timeout: 8_000 });
    // Initially undo button visible for rejected rows
    await expect(page.getByRole('button', { name: 'undo' })).toBeVisible();

    await page.getByRole('button', { name: 'undo' }).click();

    await expect.poll(() => patchBody, { timeout: 6_000 }).toEqual({ action: 'restore' });

    // After refresh: queued status replaces rejected, promote/reject buttons return
    await expect(page.getByText('queued')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'Promote' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
  });
});

test.describe('Initiatives page — preview mining', () => {
  test('Preview mining button fetches candidates and shows results', async ({ page }) => {
    await stubShellRoutes(page);
    // Override projects to return one project so preview row renders
    await page.route('**/api/projects', (route: Route) =>
      route.fulfill({
        json: {
          tasks: [{ project: 'preview-proj', path: '/tmp/preview-proj' }],
          priorities: [],
          issueCounts: {},
        },
      }),
    );
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({ json: makeInitiativesResponse([]) }),
    );
    await page.route(
      '**/api/projects/by-project/preview-proj/initiatives/preview',
      (route: Route) =>
        route.fulfill({
          json: {
            project: 'preview-proj',
            generatedAt: now(),
            candidates: [
              {
                kind: 'todo',
                title: 'Resolve the TODO in auth handler',
                rationale: 'Blocking security fix.',
                score: 85,
                dedupKey: 'todo:auth-handler:42',
              },
            ],
          },
        }),
    );

    await page.goto('/recommendations?tab=initiatives');

    // Preview section renders the project row
    await expect(page.getByRole('button', { name: 'Preview mining' })).toBeVisible({ timeout: 8_000 });

    await page.getByRole('button', { name: 'Preview mining' }).click();

    // Candidate appears after the fetch
    await expect(page.getByText('Resolve the TODO in auth handler')).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('Blocking security fix.')).toBeVisible();
  });

  test('Preview mining shows error callout when API fails', async ({ page }) => {
    await stubShellRoutes(page);
    await page.route('**/api/projects', (route: Route) =>
      route.fulfill({
        json: {
          tasks: [{ project: 'broken-proj', path: '/tmp/broken-proj' }],
          priorities: [],
          issueCounts: {},
        },
      }),
    );
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({ json: makeInitiativesResponse([]) }),
    );
    await page.route(
      '**/api/projects/by-project/broken-proj/initiatives/preview',
      (route: Route) => route.fulfill({ status: 500, body: '{"error":"probe failed"}' }),
    );

    await page.goto('/recommendations?tab=initiatives');

    await expect(page.getByRole('button', { name: 'Preview mining' })).toBeVisible({ timeout: 8_000 });

    await page.getByRole('button', { name: 'Preview mining' }).click();

    await expect(page.getByText(/Failed to preview/)).toBeVisible({ timeout: 8_000 });
  });

  test('Preview mining shows "No mineable chores found" when no candidates returned', async ({
    page,
  }) => {
    await stubShellRoutes(page);
    await page.route('**/api/projects', (route: Route) =>
      route.fulfill({
        json: {
          tasks: [{ project: 'clean-proj', path: '/tmp/clean-proj' }],
          priorities: [],
          issueCounts: {},
        },
      }),
    );
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({ json: makeInitiativesResponse([]) }),
    );
    await page.route(
      '**/api/projects/by-project/clean-proj/initiatives/preview',
      (route: Route) =>
        route.fulfill({
          json: { project: 'clean-proj', generatedAt: now(), candidates: [] },
        }),
    );

    await page.goto('/recommendations?tab=initiatives');
    await expect(page.getByRole('button', { name: 'Preview mining' })).toBeVisible({ timeout: 8_000 });

    await page.getByRole('button', { name: 'Preview mining' }).click();

    await expect(
      page.getByText('No mineable chores found — clean.'),
    ).toBeVisible({ timeout: 8_000 });
  });
});

test.describe('Initiatives page — show more / collapse backlog', () => {
  test('collapses to top 3 per project and shows "show N more" expander', async ({ page }) => {
    // 5 initiatives for same project → TOP=3 visible, 2 hidden
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeInitiative({ id: i + 10, title: `Initiative ${i + 1}`, score: 90 - i * 5 }),
    );

    await stubShellRoutes(page);
    await page.route('**/api/initiatives', (route: Route) =>
      route.fulfill({ json: makeInitiativesResponse(rows) }),
    );

    await page.goto('/recommendations?tab=initiatives');

    await expect(page.getByText('Initiative 1')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Initiative 3')).toBeVisible();
    // 4th and 5th are hidden until expanded
    await expect(page.getByText('Initiative 4')).not.toBeVisible();
    await expect(page.getByText('Initiative 5')).not.toBeVisible();

    // Expander shows how many are hidden
    await expect(page.getByRole('button', { name: 'show 2 more' })).toBeVisible();

    // Clicking expander reveals all items
    await page.getByRole('button', { name: 'show 2 more' }).click();
    await expect(page.getByText('Initiative 4')).toBeVisible();
    await expect(page.getByText('Initiative 5')).toBeVisible();

    // Collapse again
    await expect(page.getByRole('button', { name: 'show less' })).toBeVisible();
    await page.getByRole('button', { name: 'show less' }).click();
    await expect(page.getByText('Initiative 4')).not.toBeVisible();
  });
});
