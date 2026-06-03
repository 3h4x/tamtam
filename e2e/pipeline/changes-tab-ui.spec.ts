import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// UI tests for the ChangesTab states:
// loading skeleton → file list, diff expand (loading → content), collapse,
// per-file diff fetch error, empty state, and load-error retry.
// All API calls are mocked via page.route(); no real git/pipeline execution.

const PROJECT = 'changes-tab-ui';

function makeTask() {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
    path: `/tmp/${PROJECT}`,
    fires_at: '',
    sync: true,
    changes: 2,
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

function makeChanges(overrides: Record<string, unknown> = {}) {
  return {
    files: [
      { status: 'M', filename: 'lib/foo.ts', additions: 12, deletions: 3, binary: false },
      { status: 'A', filename: 'lib/bar.ts', additions: 40, deletions: 0, binary: false },
    ],
    totalFiles: 2,
    totalAdditions: 52,
    totalDeletions: 3,
    branch: 'master',
    defaultBranch: 'master',
    behind: 0,
    ahead: 0,
    ...overrides,
  };
}

// Stub every endpoint the project detail shell hits, leaving the /changes and
// /changes/diff routes for each test to override as needed.
async function stubShell(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/settings', (route: Route) => {
    if (route.request().method() !== 'GET') { route.continue(); return; }
    route.fulfill({ json: { settings: { jobs_paused: 'false', retrieval_enabled: 'false' } } });
  });
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues?summary=1`, (route: Route) =>
    route.fulfill({
      json: { repo: '', prCount: 0, issueCount: 0, openPrBranches: [], error: null, cached: true, cachedAt: 0 },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/agents**', (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

test.describe('ChangesTab states', () => {
  // -------------------------------------------------------------------------
  // Test 1: file list renders with summary counts
  // -------------------------------------------------------------------------
  test('renders changed files with summary additions/deletions', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      route.fulfill({ json: makeChanges() });
    });

    await page.goto(`/project/${PROJECT}/changes`);

    await expect(page.getByText('lib/foo.ts')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('lib/bar.ts')).toBeVisible();
    // Summary bar shows file count + totals.
    await expect(page.getByText('2 files')).toBeVisible();
    await expect(page.getByText('+52')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Test 2: expanding a file shows a diff loading skeleton then the diff
  // -------------------------------------------------------------------------
  test('expanding a file loads and displays its diff', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      route.fulfill({ json: makeChanges() });
    });
    // Delay the diff slightly so the loading skeleton is observable.
    await page.route(`**/api/projects/by-project/${PROJECT}/changes/diff**`, async (route: Route) => {
      await new Promise((r) => setTimeout(r, 60));
      await route.fulfill({
        json: { diff: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+added line', untracked: false },
      });
    });

    await page.goto(`/project/${PROJECT}/changes`);
    const fooRow = page.getByRole('button', { name: /lib\/foo\.ts/ });
    await expect(fooRow).toBeVisible({ timeout: 8_000 });
    await fooRow.click();

    // Diff body eventually shows the diff content lines.
    await expect(page.getByText('+new line')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('+added line')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Test 3: collapsing an expanded file hides the diff content
  // -------------------------------------------------------------------------
  test('collapsing an expanded file hides its diff', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      route.fulfill({ json: makeChanges() });
    });
    await page.route(`**/api/projects/by-project/${PROJECT}/changes/diff**`, (route: Route) =>
      route.fulfill({ json: { diff: '@@ -1 +1 @@\n+marker-line', untracked: false } }),
    );

    await page.goto(`/project/${PROJECT}/changes`);
    const fooRow = page.getByRole('button', { name: /lib\/foo\.ts/ });
    await expect(fooRow).toBeVisible({ timeout: 8_000 });

    await fooRow.click();
    await expect(page.getByText('+marker-line')).toBeVisible({ timeout: 5_000 });

    await fooRow.click();
    await expect(page.getByText('+marker-line')).not.toBeVisible({ timeout: 3_000 });
  });

  // -------------------------------------------------------------------------
  // Test 4: a failed diff fetch shows a per-file error message
  // -------------------------------------------------------------------------
  test('a failed diff fetch shows an inline error', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      route.fulfill({ json: makeChanges() });
    });
    await page.route(`**/api/projects/by-project/${PROJECT}/changes/diff**`, (route: Route) =>
      route.fulfill({ status: 500, json: { detail: 'diff unavailable' } }),
    );

    await page.goto(`/project/${PROJECT}/changes`);
    const fooRow = page.getByRole('button', { name: /lib\/foo\.ts/ });
    await expect(fooRow).toBeVisible({ timeout: 8_000 });
    await fooRow.click();

    await expect(page.getByText('diff unavailable')).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // Test 5: empty changes shows the "No uncommitted changes" empty state
  // -------------------------------------------------------------------------
  test('empty changes shows the empty state with branch name', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      route.fulfill({
        json: makeChanges({ files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 }),
      });
    });

    await page.goto(`/project/${PROJECT}/changes`);

    await expect(page.getByText('No uncommitted changes.')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('on branch')).toBeVisible();
    await expect(page.getByText('master', { exact: true }).first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Test 6: a failed changes load shows an error state with retry
  // -------------------------------------------------------------------------
  test('a failed changes load shows an error state and retry recovers', async ({ page }) => {
    await stubShell(page);
    let failNext = true;
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      if (failNext) {
        failNext = false;
        route.fulfill({ status: 500, json: { detail: 'failed to read git status' } });
        return;
      }
      route.fulfill({ json: makeChanges() });
    });

    await page.goto(`/project/${PROJECT}/changes`);

    await expect(page.getByText('failed to read git status')).toBeVisible({ timeout: 8_000 });

    // Clicking retry re-fetches; second response succeeds and shows the file list.
    await page.getByRole('button', { name: /retry/i }).click();
    await expect(page.getByText('lib/foo.ts')).toBeVisible({ timeout: 5_000 });
  });
});
