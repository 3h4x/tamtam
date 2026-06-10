import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for a previously-untested StatusStrip bug: when a *new*
// review/test is running while a *prior finished* job of the same kind still
// exists, the running card's "started X ago" detail and its click target must
// reference the RUNNING job — not the stale latest-finished job.
//
// Before the fix, ProjectDetailPage passed only `latestReview`/`latestTest`
// (the latest *finished* job) into the running branch, so clicking the running
// card navigated to the old finished job's page, and the "started" timestamp
// reflected the prior run instead of the live one.

const PROJECT = 'status-strip-running-link-ui';
const now = () => Math.floor(Date.now() / 1000);

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function makeJob(
  kind: 'review' | 'test',
  status: 'running' | 'done',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `${kind}-job`,
    project: PROJECT,
    kind,
    status,
    exit_code: status === 'done' ? 0 : null,
    verdict: kind === 'review' && status === 'done' ? 'LGTM' : null,
    started_at: now() - 30,
    finished_at: status === 'done' ? now() - 3 : null,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  };
}

async function stubOverviewRoutes(
  page: Page,
  opts: { jobs: () => Array<Record<string, unknown>> },
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
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
        tests_disabled: false,
        review_disabled: false,
        issue_auto_branch: false,
      },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/issues?summary=1`,
    (route: Route) =>
      route.fulfill({
        json: {
          repo: '',
          issueCount: 0,
          prCount: 0,
          openPrBranches: [],
          error: null,
          cached: true,
          cachedAt: Date.now(),
        },
      }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: opts.jobs(), pendingReleaseProjects: [] } }),
  );
}

test.describe('Overview StatusStrip running-card links to the live job', () => {
  test('running Review card opens the running review, not the prior finished one', async ({
    page,
  }) => {
    const priorReview = makeJob('review', 'done', {
      id: 'review-prior-finished',
      started_at: now() - 900,
      finished_at: now() - 840,
    });
    const runningReview = makeJob('review', 'running', {
      id: 'review-currently-running',
      started_at: now() - 5,
      finished_at: null,
    });

    await stubOverviewRoutes(page, { jobs: () => [runningReview, priorReview] });

    await page.goto(`/project/${PROJECT}`);

    const running = page.getByRole('button', { name: /Review\s+running/i });
    await expect(running).toBeVisible({ timeout: 8_000 });
    await expect(running).toBeEnabled();

    // Clicking the running card must navigate to the RUNNING job, never the
    // stale prior-finished review.
    await running.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('job'), { timeout: 8_000 })
      .toBe('review-currently-running');
  });

  test('running Tests card opens the running test, not the prior finished one', async ({
    page,
  }) => {
    const priorTest = makeJob('test', 'done', {
      id: 'test-prior-finished',
      started_at: now() - 900,
      finished_at: now() - 840,
    });
    const runningTest = makeJob('test', 'running', {
      id: 'test-currently-running',
      started_at: now() - 5,
      finished_at: null,
    });

    await stubOverviewRoutes(page, { jobs: () => [runningTest, priorTest] });

    await page.goto(`/project/${PROJECT}`);

    const running = page.getByRole('button', { name: /Tests\s+running/i });
    await expect(running).toBeVisible({ timeout: 8_000 });
    await expect(running).toBeEnabled();

    await running.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('job'), { timeout: 8_000 })
      .toBe('test-currently-running');
  });
});
