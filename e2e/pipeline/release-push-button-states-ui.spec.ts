import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Header Push-button state UI tests — verify the standalone "Push" action in the
// project header (components/project-detail/ProjectActions.tsx, the unpushed /
// totalChanges-driven button at the end of the action row). The header Pull
// button is covered by e2e/pull-flow.spec.ts and the ChangesTab push by
// changes-tab-actions-ui.spec.ts. These render states stay isolated here:
//
//   1. unpushed>0 + no local changes -> "Push (N)" warning variant, enabled,
//      title "Push N commits to origin".
//   2. local changes present -> Push disabled, title tells the user to commit
//      first (use Release).
//   3. nothing unpushed + no changes -> plain "Push", disabled, "Nothing to
//      push".
//   4. jobs paused -> Push disabled with the global-pause explanation.
//
// Pure render-state assertions driven by mocked API responses (page.route), so
// the project does not need registration in global-setup and no job is started.

const PROJECT = 'release-push-button-states-ui';

interface TaskOverrides {
  changes?: number;
  unpushed?: number;
}

function makeTask(o: TaskOverrides = {}) {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${PROJECT}`,
    fires_at: '',
    sync: true,
    changes: o.changes ?? 0,
    unpushed: o.unpushed ?? 0,
    reviewed: false,
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

interface ScenarioOpts {
  task?: TaskOverrides;
  jobsPaused?: boolean;
}

async function stubRoutes(page: Page, opts: ScenarioOpts = {}): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(opts.task)], priorities: [], issueCounts: {} },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({
      json: {
        project: PROJECT,
        test_command: '',
        detected_test_command: '',
        effective_test_command: '',
        test_cron_enabled: false,
        test_cron_schedule: '',
        auto_push_enabled: false,
        auto_commit_enabled: false,
        auto_pr_merge_enabled: false,
        pr_workflow_enabled: false,
        release_after_run: false,
        tests_disabled: true,
        review_disabled: false,
        issue_auto_branch: false,
        website: null,
      },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({
      json: { branch: 'master', defaultBranch: 'master', commitsAhead: null },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues**`, (route: Route) =>
    route.fulfill({
      json: {
        repo: '',
        prs: [],
        issues: [],
        prCount: 0,
        issueCount: 0,
        openPrBranches: [],
        error: null,
        cached: false,
        cachedAt: 0,
      },
    }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: { jobs_paused: opts.jobsPaused ? 'true' : 'false' },
        github_owner: '',
      },
    }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
}

// Locate the standalone header Push button (label "Push" or "Push (N)"), never
// the "Push to PR" button (which is not rendered on a clean master branch here).
function headerPushButton(page: Page) {
  return page.getByRole('button', { name: /^Push( \(\d+\))?$/ });
}

// ---------------------------------------------------------------------------
// Test 1: unpushed commits, clean tree -> "Push (N)" warning, enabled
// ---------------------------------------------------------------------------
test('Push button shows "Push (N)" in the warning variant and is enabled when commits are unpushed with a clean tree', async ({
  page,
}) => {
  await stubRoutes(page, { task: { changes: 0, unpushed: 2 } });

  await page.goto(`/project/${PROJECT}/issues`);

  const pushBtn = headerPushButton(page);
  await expect(pushBtn).toBeVisible({ timeout: 8_000 });
  await expect(pushBtn).toHaveText('Push (2)');
  await expect(pushBtn).not.toBeDisabled();
  await expect(pushBtn).toHaveAttribute('title', /Push 2 commits to origin/i);
  // Warning variant carries the status-warning text token.
  await expect(pushBtn).toHaveClass(/text-status-warning/);
});

// ---------------------------------------------------------------------------
// Test 2: local changes present -> Push disabled, "commit first" title
// ---------------------------------------------------------------------------
test('Push button is disabled with a commit-first title when there are uncommitted local changes', async ({
  page,
}) => {
  await stubRoutes(page, { task: { changes: 3, unpushed: 1 } });

  await page.goto(`/project/${PROJECT}/issues`);

  const pushBtn = headerPushButton(page);
  await expect(pushBtn).toBeVisible({ timeout: 8_000 });
  await expect(pushBtn).toHaveText('Push (1)');
  await expect(pushBtn).toBeDisabled();
  await expect(pushBtn).toHaveAttribute('title', /Commit your 3 local changes first \(use Release\)/i);
});

// ---------------------------------------------------------------------------
// Test 3: nothing to push -> plain "Push", disabled, "Nothing to push"
// ---------------------------------------------------------------------------
test('Push button is plain "Push", disabled, with a "Nothing to push" title when there is nothing unpushed', async ({
  page,
}) => {
  await stubRoutes(page, { task: { changes: 0, unpushed: 0 } });

  await page.goto(`/project/${PROJECT}/issues`);

  const pushBtn = headerPushButton(page);
  await expect(pushBtn).toBeVisible({ timeout: 8_000 });
  await expect(pushBtn).toHaveText('Push');
  await expect(pushBtn).toBeDisabled();
  await expect(pushBtn).toHaveAttribute('title', /Nothing to push/i);
});

// ---------------------------------------------------------------------------
// Test 4: jobs paused -> Push disabled with the global-pause explanation
// ---------------------------------------------------------------------------
test('Push button is disabled with the global-pause title when jobs are paused, even with unpushed commits', async ({
  page,
}) => {
  await stubRoutes(page, { task: { changes: 0, unpushed: 2 }, jobsPaused: true });

  await page.goto(`/project/${PROJECT}/issues`);

  const pushBtn = headerPushButton(page);
  await expect(pushBtn).toBeVisible({ timeout: 8_000 });
  await expect(pushBtn).toHaveText('Push (2)');
  await expect(pushBtn).toBeDisabled();
  await expect(pushBtn).toHaveAttribute('title', /Jobs are paused globally\. Resume jobs to start a push\./i);
});
