import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// UI tests for the ChangesTab git action flows: push (ahead), pull (behind),
// diverged-pull strategy picker (rebase/merge), and switch-to-default-branch.
// All API calls are mocked via page.route(); no real git/pipeline execution.

const PROJECT = 'changes-tab-actions-ui';

function makeTask() {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
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
}

function makeChanges(overrides: Record<string, unknown> = {}) {
  return {
    files: [
      { status: 'M', filename: 'lib/foo.ts', additions: 12, deletions: 3, binary: false },
    ],
    totalFiles: 1,
    totalAdditions: 12,
    totalDeletions: 3,
    branch: 'master',
    defaultBranch: 'master',
    behind: 0,
    ahead: 0,
    ...overrides,
  };
}

// Stub every endpoint the project detail shell hits, leaving /changes and the
// git-action routes for each test to override as needed.
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

test.describe('ChangesTab git actions', () => {
  // -------------------------------------------------------------------------
  // Test 1: Push button (ahead>0) starts a push job and navigates to terminal
  // -------------------------------------------------------------------------
  test('pushing ahead commits navigates to the push terminal', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      route.fulfill({ json: makeChanges({ ahead: 2 }) });
    });
    let pushCalled = false;
    await page.route(`**/api/projects/by-project/${PROJECT}/push`, (route: Route) => {
      pushCalled = true;
      route.fulfill({ json: { status: 'started', job_id: 'push-job-123' } });
    });

    await page.goto(`/project/${PROJECT}/changes`);

    const pushBtn = page.getByTitle(/Push 2 commits to origin/);
    await expect(pushBtn).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('↑ 2 commits ahead')).toBeVisible();
    await pushBtn.click();

    await expect(page).toHaveURL(/\/terminal\?job=push-job-123/, { timeout: 8_000 });
    expect(pushCalled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: Push failure surfaces an inline error and stays on the page
  // -------------------------------------------------------------------------
  test('a failed push shows an inline error', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      route.fulfill({ json: makeChanges({ ahead: 1 }) });
    });
    await page.route(`**/api/projects/by-project/${PROJECT}/push`, (route: Route) =>
      route.fulfill({ status: 500, json: { detail: 'remote rejected push' } }),
    );

    await page.goto(`/project/${PROJECT}/changes`);

    const pushBtn = page.getByTitle(/Push 1 commit to origin/);
    await expect(pushBtn).toBeVisible({ timeout: 8_000 });
    await pushBtn.click();

    await expect(page.getByText('remote rejected push')).toBeVisible({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/changes$/);
  });

  // -------------------------------------------------------------------------
  // Test 3: Pull (behind>0, clean tree) succeeds and clears the behind banner
  // -------------------------------------------------------------------------
  test('pulling behind commits clears the behind indicator', async ({ page }) => {
    await stubShell(page);
    let pulled = false;
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      const method = route.request().method();
      if (method === 'POST') {
        pulled = true;
        route.fulfill({ json: { status: 'ok', output: 'Updated 1 file' } });
        return;
      }
      // After a successful pull, the refresh fetch reports no behind commits.
      route.fulfill({
        json: makeChanges({ files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0, behind: pulled ? 0 : 3 }),
      });
    });

    await page.goto(`/project/${PROJECT}/changes`);

    const pullBtn = page.getByTitle(/git pull --ff-only/);
    await expect(pullBtn).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/↓ 3 commits behind/)).toBeVisible();
    await pullBtn.click();

    await expect(page.getByText(/commits behind/)).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('No uncommitted changes')).toBeVisible();
    expect(pulled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: Diverged pull surfaces the strategy picker; Rebase recovers
  // -------------------------------------------------------------------------
  test('a diverged pull shows the strategy picker and rebase recovers', async ({ page }) => {
    await stubShell(page);
    const attempts: Array<string | undefined> = [];
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      const method = route.request().method();
      if (method === 'POST') {
        const body = route.request().postDataJSON() as { strategy?: string };
        attempts.push(body.strategy);
        if (attempts.length === 1) {
          // First ff-only pull reports divergence.
          route.fulfill({ status: 409, json: { diverged: true } });
        } else {
          // Rebase succeeds.
          route.fulfill({ json: { status: 'ok', output: 'Rebased' } });
        }
        return;
      }
      route.fulfill({
        json: makeChanges({ files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0, behind: attempts.length >= 2 ? 0 : 2 }),
      });
    });

    await page.goto(`/project/${PROJECT}/changes`);

    const pullBtn = page.getByTitle(/git pull --ff-only/);
    await expect(pullBtn).toBeVisible({ timeout: 8_000 });
    await pullBtn.click();

    // Strategy picker appears.
    await expect(page.getByText('Branches diverged — choose strategy:')).toBeVisible({ timeout: 5_000 });
    const rebaseBtn = page.getByTitle(/git pull --rebase/);
    await expect(rebaseBtn).toBeVisible();
    await page.getByTitle(/git pull --no-ff/).waitFor();

    await rebaseBtn.click();

    // After rebase, the picker and behind indicator are gone.
    await expect(page.getByText('Branches diverged — choose strategy:')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/commits behind/)).not.toBeVisible();
    expect(attempts).toEqual(['ff-only', 'rebase']);
  });

  // -------------------------------------------------------------------------
  // Test 5: Diverged pull surfaces the strategy picker; Merge recovers
  // -------------------------------------------------------------------------
  test('a diverged pull shows the strategy picker and merge recovers', async ({ page }) => {
    await stubShell(page);
    const attempts: Array<string | undefined> = [];
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      const method = route.request().method();
      if (method === 'POST') {
        const body = route.request().postDataJSON() as { strategy?: string };
        attempts.push(body.strategy);
        if (attempts.length === 1) {
          route.fulfill({ status: 409, json: { diverged: true } });
          return;
        }
        route.fulfill({ json: { status: 'ok', output: 'Merged' } });
        return;
      }
      route.fulfill({
        json: makeChanges({ files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0, behind: attempts.length >= 2 ? 0 : 2 }),
      });
    });

    await page.goto(`/project/${PROJECT}/changes`);

    const pullBtn = page.getByTitle(/git pull --ff-only/);
    await expect(pullBtn).toBeVisible({ timeout: 8_000 });
    await pullBtn.click();

    await expect(page.getByText('Branches diverged — choose strategy:')).toBeVisible({ timeout: 5_000 });
    await page.getByTitle(/git pull --no-ff/).click();

    await expect(page.getByText('Branches diverged — choose strategy:')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/commits behind/)).not.toBeVisible();
    await expect(page.getByText('No uncommitted changes')).toBeVisible();
    expect(attempts).toEqual(['ff-only', 'merge']);
  });

  // -------------------------------------------------------------------------
  // Test 6: Switch to default branch from a clean non-default branch
  // -------------------------------------------------------------------------
  test('switching to the default branch from a feature branch refreshes', async ({ page }) => {
    await stubShell(page);
    let switched = false;
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      route.fulfill({
        json: makeChanges({
          files: [],
          totalFiles: 0,
          totalAdditions: 0,
          totalDeletions: 0,
          branch: switched ? 'master' : 'feature/x',
          defaultBranch: 'master',
        }),
      });
    });
    await page.route(`**/api/projects/by-project/${PROJECT}/checkout-default`, (route: Route) => {
      switched = true;
      route.fulfill({ json: { status: 'ok', branch: 'master' } });
    });

    await page.goto(`/project/${PROJECT}/changes`);

    const switchBtn = page.getByRole('button', { name: 'Switch to master' });
    await expect(switchBtn).toBeVisible({ timeout: 8_000 });
    await switchBtn.click();

    // After the switch + refresh, the empty state reports the default branch.
    await expect(page.getByText('feature/x')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.locator('code', { hasText: 'master' })).toBeVisible();
    expect(switched).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7: A failed branch switch surfaces an inline error
  // -------------------------------------------------------------------------
  test('a failed branch switch shows an inline error', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) => {
      if (route.request().method() !== 'GET') { route.continue(); return; }
      route.fulfill({
        json: makeChanges({
          files: [],
          totalFiles: 0,
          totalAdditions: 0,
          totalDeletions: 0,
          branch: 'feature/x',
          defaultBranch: 'master',
        }),
      });
    });
    await page.route(`**/api/projects/by-project/${PROJECT}/checkout-default`, (route: Route) =>
      route.fulfill({ status: 500, json: { detail: 'uncommitted changes block checkout' } }),
    );

    await page.goto(`/project/${PROJECT}/changes`);

    const switchBtn = page.getByRole('button', { name: 'Switch to master' });
    await expect(switchBtn).toBeVisible({ timeout: 8_000 });
    await switchBtn.click();

    await expect(page.getByText('uncommitted changes block checkout')).toBeVisible({ timeout: 5_000 });
  });
});
