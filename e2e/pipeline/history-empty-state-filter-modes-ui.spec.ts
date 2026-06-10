import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// History tab empty-state mode coverage for `failed` and `filtered` variants.
//
// Both modes are hard to reach via a static mock because the filter chips only
// appear when count > 0 (else hidden) OR when the chip is already the active
// filter. The trick: serve an entry that makes the chip visible, click it,
// then flip the mock to serve only non-matching entries so `filtered.length`
// becomes 0 while `entries.length > 0` — which is the exact condition that
// routes to `failed` / `filtered` mode rather than the simpler `empty` mode.

const PROJECT = 'history-empty-state-filter-modes';

const BASE_TASK = {
  id: `${PROJECT}-1`,
  project: PROJECT,
  job: null,
  priority: null,
  launchctl: 'running',
  path: `/tmp/${PROJECT}`,
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

type MockJob = {
  id: string;
  project: string;
  kind: string;
  status: 'running' | 'done';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  session_id?: string;
  pid?: number;
  log_path?: string;
  seen?: boolean;
};

function now() {
  return Math.floor(Date.now() / 1000);
}

function makeJob(id: string, kind: string, exitCode: number | null): MockJob {
  return {
    id,
    project: PROJECT,
    kind,
    status: exitCode === null ? 'running' : 'done',
    exit_code: exitCode,
    started_at: now() - 120,
    finished_at: exitCode === null ? null : now() - 60,
    session_id: `sess-${id}`,
    pid: 0,
    log_path: '',
    seen: true,
  };
}

async function stubRoutes(page: Page, getJobs: () => MockJob[]): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [BASE_TASK], priorities: [], issueCounts: {} } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const jobs = getJobs();
      route.fulfill({ json: { jobs, pendingReleaseProjects: [] } });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: { total: 1, byStatus: { running: 0, done: 1 }, tokens: { total: 0 }, cost: { monthToDate: 0 } },
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
  );
}

test.describe('History tab failed and filtered empty-state modes', () => {
  // -------------------------------------------------------------------------
  // `failed` mode — active "failed" filter + no matching entries
  //
  // entryNeedsAttention: status=done && exit_code !== 0 → counts as failed.
  // Chip renders when count > 0 OR when it IS the active filter.
  // After the user clicks, flip mock to a clean version of the SAME job ID so
  // mergeJobs overwrites it in-place → filtered becomes empty →
  // emptyStateMode = 'failed' → "No runs need attention".
  // -------------------------------------------------------------------------
  test('failed empty-state shows "No runs need attention" when failed filter is active but no entries match', async ({
    page,
  }) => {
    let servePhase: 'initial' | 'clean' = 'initial';

    await stubRoutes(page, () =>
      servePhase === 'initial'
        ? [makeJob('job-fail-shared', 'test', 1)]
        : [makeJob('job-fail-shared', 'test', 0)],
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Initial state: failed chip visible with count=1.
    const failedChip = page.getByRole('button', { name: /^failed 1$/ });
    await expect(failedChip).toBeVisible({ timeout: 8_000 });

    // Click the "failed" filter chip — now filter='failed', failed job shown.
    await failedChip.click();
    await expect(page.getByText('exit 1', { exact: true })).toBeVisible();

    // Flip mock to return a clean job (no failed entries).
    servePhase = 'clean';

    // filtered.length becomes 0 while entries.length > 0 → mode='failed'.
    await expect(page.getByText('No runs need attention')).toBeVisible({ timeout: 12_000 });
    await expect(
      page.getByText('Visible runs are either done cleanly or still in progress.'),
    ).toBeVisible();
    // "Clear filters" button must restore the full list.
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(page.getByText('No runs need attention')).toHaveCount(0);
    // Clean job is visible again after clearing the filter.
    await expect(page.getByText('done').first()).toBeVisible({ timeout: 8_000 });
  });

  // -------------------------------------------------------------------------
  // `filtered` mode — active bucket filter + no matching entries
  //
  // Bucket chips render when count > 0 OR when bucket IS the active filter.
  // Serve one 'test' job → click the 'test' bucket chip → flip mock to the
  // SAME job ID with kind='run' so mergeJobs overwrites the entry in-place
  // → filtered (bucket='test') becomes empty → emptyStateMode = 'filtered' →
  // "No test runs in view".
  // -------------------------------------------------------------------------
  test('filtered empty-state shows "No test runs in view" when test bucket is active but no test entries remain', async ({
    page,
  }) => {
    let servePhase: 'initial' | 'run-only' = 'initial';

    await stubRoutes(page, () =>
      servePhase === 'initial'
        ? [makeJob('job-kind-shared', 'test', 0)]
        : [makeJob('job-kind-shared', 'run', 0)],
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Bucket chip 'test 1' appears.
    const testChip = page.getByRole('button', { name: /^test 1$/ });
    await expect(testChip).toBeVisible({ timeout: 8_000 });

    // Click the test bucket chip → filter = {kind: 'bucket', bucket: 'test'}.
    await testChip.click();
    // The test job is visible under the filter.
    await expect(page.getByText('done').first()).toBeVisible();

    // Flip mock to a 'run' job — no test entries remain.
    servePhase = 'run-only';

    // filtered becomes empty while entries.length > 0 → mode='filtered'.
    await expect(
      page.getByText('No test runs in view', { exact: false }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(
      page.getByText('This filter is empty for the current history window.'),
    ).toBeVisible();
    // Clear filters restores the full list showing the run job.
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(page.getByText('No test runs in view', { exact: false })).toHaveCount(0);
    await expect(page.getByText('done').first()).toBeVisible({ timeout: 8_000 });
  });
});
