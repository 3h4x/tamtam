import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Release-button state UI tests — verify that the primary action button in the
// project header (components/project-detail/ProjectActions.tsx) renders the
// correct label / title / disabled state for verdict- and branch-driven
// branches:
//
//   1. freshLgtm  -> button reads "Ship (LGTM)" and its title explains it will
//      commit & push directly, skipping test + review.
//   2. nothingToRelease -> button is disabled with the "Nothing to release"
//      title (no changes, no unpushed commits).
//   3. feature branch with no open PR -> a "Create PR" button appears alongside
//      Release.
//
// These are pure render-state assertions driven entirely by mocked API
// responses (page.route), so the project does not need to be registered in
// global-setup. No real jobs are started.

const PROJECT = 'release-button-states-ui';

interface TaskOverrides {
  changes?: number;
  unpushed?: number;
  reviewed?: boolean;
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
    reviewed: o.reviewed ?? false,
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
  /** Jobs returned by GET /api/jobs?project=… — used to inject a review verdict. */
  jobs?: Array<Record<string, unknown>>;
  branch?: { branch: string; defaultBranch: string; commitsAhead: number | null };
  openPrBranches?: Array<{ branch: string; number: number }>;
  jobsPaused?: boolean;
}

async function stubRoutes(page: Page, opts: ScenarioOpts = {}): Promise<void> {
  const branch = opts.branch ?? { branch: 'master', defaultBranch: 'master', commitsAhead: null };

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
    route.fulfill({ json: branch }),
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
        openPrBranches: opts.openPrBranches ?? [],
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
    route.fulfill({ json: { settings: { jobs_paused: opts.jobsPaused ? 'true' : 'false' }, github_owner: '' } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: opts.jobs ?? [], pendingReleaseProjects: [] } }),
  );
}

function lgtmReviewJob(): Record<string, unknown> {
  return {
    id: `${PROJECT}-review-1`,
    project: PROJECT,
    kind: 'review',
    prompt: null,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    started_at: 1_000,
    finished_at: 2_000,
    seen: true,
    verdict: 'LGTM',
  };
}

// ---------------------------------------------------------------------------
// Test 1: freshLgtm — button reads "Ship (LGTM)" with the skip-test/review title
// ---------------------------------------------------------------------------
test('Release button becomes "Ship (LGTM)" when the latest review is LGTM and nothing is unreviewed', async ({
  page,
}) => {
  // changes>0 + reviewed:true -> unreviewedCount 0 -> hasUnreviewed false.
  // A done review job with verdict LGTM -> verdict==='LGTM' -> freshLgtm true.
  await stubRoutes(page, {
    task: { changes: 4, unpushed: 0, reviewed: true },
    jobs: [lgtmReviewJob()],
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const shipBtn = page.getByRole('button', { name: 'Ship (LGTM)' });
  await expect(shipBtn).toBeVisible({ timeout: 8_000 });
  await expect(shipBtn).not.toBeDisabled();
  await expect(shipBtn).toHaveAttribute('title', /review already LGTM/i);
  await expect(shipBtn).toHaveAttribute('title', /skips test \+ review/i);

  // The generic "Release" label must NOT be shown in the freshLgtm state.
  await expect(page.getByRole('button', { name: /^Release$/ })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 2: nothingToRelease — button disabled with explanatory title
// ---------------------------------------------------------------------------
test('Release button is disabled with a "Nothing to release" title when there are no changes or unpushed commits', async ({
  page,
}) => {
  await stubRoutes(page, { task: { changes: 0, unpushed: 0 } });

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = page.getByRole('button', { name: /^Release$/ });
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
  await expect(releaseBtn).toHaveAttribute('title', /nothing to release/i);
});

// ---------------------------------------------------------------------------
// Test 3: feature branch w/o open PR — "Create PR" button appears
// ---------------------------------------------------------------------------
test('Create PR button appears on a feature branch that has commits ahead and no open PR', async ({
  page,
}) => {
  await stubRoutes(page, {
    task: { changes: 0, unpushed: 1 },
    branch: { branch: 'feature/widget', defaultBranch: 'master', commitsAhead: 3 },
    openPrBranches: [],
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const createPrBtn = page.getByRole('button', { name: 'Create PR' });
  await expect(createPrBtn).toBeVisible({ timeout: 8_000 });
  await expect(createPrBtn).not.toBeDisabled();
  await expect(createPrBtn).toHaveAttribute('title', /Create pull request for branch feature\/widget/i);
});

// ---------------------------------------------------------------------------
// Test 4: feature branch with open PR + local changes — "Push to PR #N" appears
// ---------------------------------------------------------------------------
test('Push to PR button appears with PR number when feature branch has an open PR and local changes', async ({
  page,
}) => {
  await stubRoutes(page, {
    task: { changes: 3, unpushed: 0 },
    branch: { branch: 'feature/widget', defaultBranch: 'master', commitsAhead: 3 },
    openPrBranches: [{ branch: 'feature/widget', number: 42 }],
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const pushToPrBtn = page.getByRole('button', { name: 'Push to PR #42' });
  await expect(pushToPrBtn).toBeVisible({ timeout: 8_000 });
  await expect(pushToPrBtn).not.toBeDisabled();
  // Title explains what the push does and references the PR number implicitly via changes count.
  await expect(pushToPrBtn).toHaveAttribute('title', /Stage 3 change/i);
  await expect(pushToPrBtn).toHaveAttribute('title', /Skips test \+ review/i);

  // "Create PR" must NOT appear — the branch already has an open PR.
  await expect(page.getByRole('button', { name: 'Create PR' })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 5: feature branch w/ no commits ahead — "Create PR" disabled w/ explanation
// ---------------------------------------------------------------------------
test('Create PR button is disabled with an explanatory title when feature branch has no commits ahead', async ({
  page,
}) => {
  await stubRoutes(page, {
    task: { changes: 0, unpushed: 0 },
    branch: { branch: 'feature/empty', defaultBranch: 'master', commitsAhead: 0 },
    openPrBranches: [],
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const createPrBtn = page.getByRole('button', { name: 'Create PR' });
  await expect(createPrBtn).toBeVisible({ timeout: 8_000 });
  await expect(createPrBtn).toBeDisabled();
  await expect(createPrBtn).toHaveAttribute('title', /no commits ahead/i);
  await expect(createPrBtn).toHaveAttribute('title', /feature\/empty/i);
});

// ---------------------------------------------------------------------------
// Test 6: jobs_paused — Release button is disabled with global-pause title
// ---------------------------------------------------------------------------
test('Release button is disabled with a global-pause title when jobs_paused is true', async ({
  page,
}) => {
  await stubRoutes(page, {
    task: { changes: 3, unpushed: 0 },
    jobsPaused: true,
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const releaseBtn = page.getByRole('button', { name: /^Release$/ });
  await expect(releaseBtn).toBeVisible({ timeout: 8_000 });
  await expect(releaseBtn).toBeDisabled();
  await expect(releaseBtn).toHaveAttribute('title', /jobs are paused globally/i);
  await expect(releaseBtn).toHaveAttribute('title', /resume jobs to start a release/i);
});

// ---------------------------------------------------------------------------
// Test 7: jobs_paused on feature branch — Create PR button shows paused title
// ---------------------------------------------------------------------------
test('Create PR button is disabled with a global-pause title when jobs_paused is true', async ({
  page,
}) => {
  await stubRoutes(page, {
    task: { changes: 0, unpushed: 2 },
    branch: { branch: 'feature/paused-branch', defaultBranch: 'master', commitsAhead: 2 },
    openPrBranches: [],
    jobsPaused: true,
  });

  await page.goto(`/project/${PROJECT}/issues`);

  const createPrBtn = page.getByRole('button', { name: 'Create PR' });
  await expect(createPrBtn).toBeVisible({ timeout: 8_000 });
  await expect(createPrBtn).toBeDisabled();
  await expect(createPrBtn).toHaveAttribute('title', /jobs are paused globally/i);
  await expect(createPrBtn).toHaveAttribute('title', /resume jobs to create a pr/i);
});
