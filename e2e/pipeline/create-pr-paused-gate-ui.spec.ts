import { test, expect, Route } from '@playwright/test';

// E2E coverage for the global pause gate on the project header's "Create PR"
// button (components/project-detail/ProjectActions.tsx, the `showCreatePr`
// branch). Create PR pushes commits to origin and runs `gh pr create` — an
// outbound action of exactly the kind the global `jobs_paused` gate exists to
// stop. Every sibling action button (Release / Test / Push / Push-to-PR /
// Fix CI / custom actions) disables itself when jobs are paused. This spec pins
// the same behavior for Create PR: the button is disabled with the standard
// paused tooltip when jobs are paused, and enabled when they are not.
//
// All HTTP calls are mocked — no real git/gh invocations and no global-setup
// project registration.

const PROJECT = 'create-pr-paused-gate-ui';
const FEATURE_BRANCH = 'feature/add-thing';

interface MockOpts {
  jobsPaused: boolean;
  // Records any POST to the create-pr route so the test can prove a paused
  // click sends nothing.
  onCreatePr?: () => void;
}

async function mockRoutes(page: import('@playwright/test').Page, opts: MockOpts) {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [{
          project: PROJECT,
          path: `/tmp/${PROJECT}`,
          github: 'https://github.com/test/repo',
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
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: opts.jobsPaused ? 'true' : 'false' } } }),
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
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  // On a feature branch, 2 commits ahead of origin/master, no open PR yet —
  // this is exactly the state that surfaces the Create PR button.
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({
      json: { branch: FEATURE_BRANCH, defaultBranch: 'master', commitsAhead: 2 },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues**`, (route: Route) =>
    route.fulfill({
      json: {
        repo: 'test/repo', prCount: 0, issueCount: 0,
        openPrBranches: [], error: null, cached: false, cachedAt: 0,
      },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/create-pr`, (route: Route) => {
    opts.onCreatePr?.();
    return route.fulfill({ json: { url: 'https://github.com/test/repo/pull/1' } });
  });
  await page.route(`**/api/projects/by-project/${PROJECT}/changes`, (route: Route) =>
    route.fulfill({
      json: {
        files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0,
        branch: FEATURE_BRANCH, behind: 0, ahead: 2,
      },
    }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

// ---------------------------------------------------------------------------
// Test 1: jobs paused → Create PR is disabled with the paused tooltip
// ---------------------------------------------------------------------------
test('Create PR is disabled with the global-pause tooltip when jobs are paused', async ({ page }) => {
  let createPrCalls = 0;
  await mockRoutes(page, { jobsPaused: true, onCreatePr: () => { createPrCalls += 1; } });
  await page.goto(`/project/${PROJECT}`);

  const createPr = page.getByRole('button', { name: 'Create PR' });
  await expect(createPr).toBeVisible({ timeout: 8_000 });
  await expect(createPr).toBeDisabled();
  await expect(createPr).toHaveAttribute(
    'title',
    'Jobs are paused globally. Resume jobs to create a PR.',
  );

  // A disabled button must not fire the outbound push/PR action. force-click to
  // prove the gate holds even if the DOM disabled state were bypassed.
  await createPr.click({ force: true }).catch(() => {});
  expect(createPrCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 2: jobs running → Create PR is enabled (control)
// ---------------------------------------------------------------------------
test('Create PR is enabled with the create tooltip when jobs are running', async ({ page }) => {
  await mockRoutes(page, { jobsPaused: false });
  await page.goto(`/project/${PROJECT}`);

  const createPr = page.getByRole('button', { name: 'Create PR' });
  await expect(createPr).toBeVisible({ timeout: 8_000 });
  await expect(createPr).toBeEnabled();
  await expect(createPr).toHaveAttribute(
    'title',
    `Create pull request for branch ${FEATURE_BRANCH}`,
  );
});
