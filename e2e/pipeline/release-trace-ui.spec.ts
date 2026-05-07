import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Release trace page UI tests — verify that /project/<name>/release/<releaseId>
// renders the correct header status badge, step list, and live-polling behaviour.
// Uses page.route() for all API mocking; no real pipeline execution involved.

const PROJECT = 'trace-ui';
const RELEASE_ID = 'rel-trace-001';
const now = () => Math.floor(Date.now() / 1000);

interface MockStep {
  job_id: string;
  kind: string;
  status: 'running' | 'done' | 'aborted';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  verdict: string | null;
  log_excerpt: string;
}

interface MockTrace {
  release_id: string;
  project: string;
  branch: string | null;
  status: 'running' | 'done' | 'aborted';
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  trigger: null;
  steps: MockStep[];
}

function makeStep(overrides: Partial<MockStep> & Pick<MockStep, 'job_id' | 'kind' | 'status' | 'exit_code' | 'started_at' | 'finished_at'>): MockStep {
  return {
    duration_ms: null,
    verdict: null,
    log_excerpt: '',
    ...overrides,
  };
}

function makeTrace(overrides: Partial<MockTrace> & Pick<MockTrace, 'status' | 'exit_code' | 'finished_at' | 'steps'>): MockTrace {
  return {
    release_id: RELEASE_ID,
    project: PROJECT,
    branch: 'master',
    started_at: now() - 120,
    trigger: null,
    ...overrides,
  };
}

async function stubShellRoutes(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
}

async function stubSettings(
  page: import('@playwright/test').Page,
  extra: Record<string, string> = {},
): Promise<void> {
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false', ...extra }, github_owner: '' } }),
  );
}

async function stubTrace(page: import('@playwright/test').Page, trace: MockTrace): Promise<void> {
  await page.route(
    `**/api/projects/by-project/${PROJECT}/release/${RELEASE_ID}`,
    (route: Route) => route.fulfill({ json: trace }),
  );
}

// ─── Test 1: success badge ────────────────────────────────────────────────────

test('release trace shows "success" status badge when release is done with exit_code 0', async ({
  page,
}) => {
  const trace = makeTrace({
    status: 'done',
    exit_code: 0,
    finished_at: now() - 10,
    steps: [
      makeStep({
        job_id: 'step-review-1',
        kind: 'review',
        status: 'done',
        exit_code: 0,
        started_at: now() - 80,
        finished_at: now() - 50,
        verdict: 'LGTM',
      }),
      makeStep({
        job_id: 'step-push-1',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        started_at: now() - 45,
        finished_at: now() - 10,
      }),
    ],
  });

  await stubShellRoutes(page);
  await stubSettings(page);
  await stubTrace(page, trace);

  await page.goto(`/project/${PROJECT}/release/${RELEASE_ID}`);

  await expect(page.getByText('success').first()).toBeVisible({ timeout: 8_000 });
  // Step kinds must be listed
  await expect(page.getByText('review').first()).toBeVisible();
  await expect(page.getByText('push').first()).toBeVisible();
  // LGTM verdict badge
  await expect(page.getByText('LGTM').first()).toBeVisible();
});

// ─── Test 2: running badge with animated dot ──────────────────────────────────

test('release trace shows animated "running" badge while release is in progress', async ({
  page,
}) => {
  const trace = makeTrace({
    status: 'running',
    exit_code: null,
    finished_at: null,
    steps: [
      makeStep({
        job_id: 'step-review-run',
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 20,
        finished_at: null,
      }),
    ],
  });

  await stubShellRoutes(page);
  await stubSettings(page);
  await stubTrace(page, trace);

  await page.goto(`/project/${PROJECT}/release/${RELEASE_ID}`);

  // Header badge: "running" with an animate-pulse dot
  await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
  // The pulse dot inside the running badge
  const pulseDot = page.locator('.animate-pulse').first();
  await expect(pulseDot).toBeVisible();

  // Step row also shows "running…" label
  await expect(page.getByText('running…').first()).toBeVisible();
});

// ─── Test 3: cancelled badge ──────────────────────────────────────────────────

test('release trace shows "cancelled" status badge for aborted releases', async ({
  page,
}) => {
  const trace = makeTrace({
    status: 'aborted',
    exit_code: -3,
    finished_at: now() - 5,
    steps: [
      makeStep({
        job_id: 'step-review-abort',
        kind: 'review',
        status: 'aborted',
        exit_code: -3,
        started_at: now() - 30,
        finished_at: now() - 5,
      }),
    ],
  });

  await stubShellRoutes(page);
  await stubSettings(page);
  await stubTrace(page, trace);

  await page.goto(`/project/${PROJECT}/release/${RELEASE_ID}`);

  await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 8_000 });
  // "success" and "running" must not appear
  await expect(page.getByText('success')).not.toBeVisible();
  await expect(page.getByText('running', { exact: true })).not.toBeVisible();
});

// ─── Test 4: failed badge ─────────────────────────────────────────────────────

test('release trace shows "failed" status badge when release exits non-zero', async ({
  page,
}) => {
  const trace = makeTrace({
    status: 'done',
    exit_code: 1,
    finished_at: now() - 5,
    steps: [
      makeStep({
        job_id: 'step-push-fail',
        kind: 'push',
        status: 'done',
        exit_code: 1,
        started_at: now() - 30,
        finished_at: now() - 5,
      }),
    ],
  });

  await stubShellRoutes(page);
  await stubSettings(page);
  await stubTrace(page, trace);

  await page.goto(`/project/${PROJECT}/release/${RELEASE_ID}`);

  await expect(page.getByText('failed').first()).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('success')).not.toBeVisible();
});

// ─── Test 5: expand step log excerpt ─────────────────────────────────────────

test('clicking a step row expands and shows its log excerpt', async ({ page }) => {
  const EXCERPT = 'Pushing to origin master... done.';
  const trace = makeTrace({
    status: 'done',
    exit_code: 0,
    finished_at: now() - 5,
    steps: [
      makeStep({
        job_id: 'step-push-expand',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        started_at: now() - 30,
        finished_at: now() - 5,
        log_excerpt: EXCERPT,
      }),
    ],
  });

  await stubShellRoutes(page);
  await stubSettings(page);
  await stubTrace(page, trace);

  await page.goto(`/project/${PROJECT}/release/${RELEASE_ID}`);

  // Wait for step row to render
  await expect(page.getByText('push').first()).toBeVisible({ timeout: 8_000 });
  // Log excerpt is hidden initially
  await expect(page.getByText(EXCERPT)).not.toBeVisible();

  // Click the step row button to expand
  await page.getByRole('button').filter({ hasText: 'push' }).first().click();

  // Excerpt is now visible
  await expect(page.getByText(EXCERPT)).toBeVisible({ timeout: 5_000 });

  // Clicking again collapses it
  await page.getByRole('button').filter({ hasText: 'push' }).first().click();
  await expect(page.getByText(EXCERPT)).not.toBeVisible();
});

// ─── Test 6: live polling updates running → done ──────────────────────────────

test('release trace live polling transitions header badge from "running" to "success" without reload', async ({
  page,
}) => {
  let serveRunning = true;

  await stubShellRoutes(page);
  await stubSettings(page);

  page.route(
    `**/api/projects/by-project/${PROJECT}/release/${RELEASE_ID}`,
    (route: Route) => {
      if (serveRunning) {
        route.fulfill({
          json: makeTrace({
            status: 'running',
            exit_code: null,
            finished_at: null,
            steps: [
              makeStep({
                job_id: 'step-review-poll',
                kind: 'review',
                status: 'running',
                exit_code: null,
                started_at: now() - 10,
                finished_at: null,
                verdict: null,
              }),
            ],
          }),
        });
      } else {
        route.fulfill({
          json: makeTrace({
            status: 'done',
            exit_code: 0,
            finished_at: now(),
            steps: [
              makeStep({
                job_id: 'step-review-poll',
                kind: 'review',
                status: 'done',
                exit_code: 0,
                started_at: now() - 30,
                finished_at: now(),
                verdict: 'LGTM',
                duration_ms: 20_000,
              }),
            ],
          }),
        });
      }
    },
  );

  await page.goto(`/project/${PROJECT}/release/${RELEASE_ID}`);

  // Phase 1: initial fetch returns running
  await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });

  // Flip mock so next poll returns done
  serveRunning = false;

  // Phase 2: ReleaseTraceView polls every 4 s — allow 12 s for the UI to update
  await expect(page.getByText('success').first()).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText('running', { exact: true })).not.toBeVisible();
  // LGTM verdict badge should now appear
  await expect(page.getByText('LGTM').first()).toBeVisible();
});

// ─── Test 7: 404 shows error state ───────────────────────────────────────────

test('release trace shows error state when release is not found', async ({ page }) => {
  await stubShellRoutes(page);
  await stubSettings(page);

  page.route(
    `**/api/projects/by-project/${PROJECT}/release/${RELEASE_ID}`,
    (route: Route) => route.fulfill({ status: 404, json: { error: 'release not found' } }),
  );

  await page.goto(`/project/${PROJECT}/release/${RELEASE_ID}`);

  await expect(page.getByText(/release not found/i).first()).toBeVisible({ timeout: 8_000 });
});

// ─── Test 8: step count and timing metadata ───────────────────────────────────

test('release trace shows correct step count and timing metadata', async ({ page }) => {
  const startTs = now() - 150;
  const endTs = now() - 10;
  const trace = makeTrace({
    status: 'done',
    exit_code: 0,
    finished_at: endTs,
    steps: [
      makeStep({ job_id: 's1', kind: 'review', status: 'done', exit_code: 0, started_at: startTs, finished_at: startTs + 60, verdict: 'LGTM' }),
      makeStep({ job_id: 's2', kind: 'commit', status: 'done', exit_code: 0, started_at: startTs + 62, finished_at: startTs + 65 }),
      makeStep({ job_id: 's3', kind: 'push', status: 'done', exit_code: 0, started_at: startTs + 66, finished_at: endTs }),
    ],
  });

  await stubShellRoutes(page);
  await stubSettings(page);
  await stubTrace(page, trace);

  await page.goto(`/project/${PROJECT}/release/${RELEASE_ID}`);

  // Header shows step count
  await expect(page.getByText('3 steps').first()).toBeVisible({ timeout: 8_000 });
  // All three step kinds visible
  await expect(page.getByText('commit').first()).toBeVisible();
});
