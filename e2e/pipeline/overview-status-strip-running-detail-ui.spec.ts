import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for the StatusStrip running Review/Tests card *detail* text.
//
// Both cards render `latestX ? "started <ago>" : <StartingDetail/>` while a job
// is running. Existing specs only ever exercise the StartingDetail placeholder
// side (a running job with no prior finished run). This spec covers the other
// branch: when a prior *finished* run already exists, a freshly running job must
// show a real "started <ago>" timestamp — NOT the transient "starting"
// placeholder — and must still point its click target at the running job.

const PROJECT = 'status-strip-running-detail-ui';
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
  kind: 'test' | 'review',
  status: 'running' | 'done',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `${kind}-job`,
    project: PROJECT,
    kind,
    status,
    exit_code: status === 'done' ? 0 : null,
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
  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) =>
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

test.describe('Overview StatusStrip running-card detail text', () => {
  // -------------------------------------------------------------------------
  // Tests card — placeholder vs timed detail
  // -------------------------------------------------------------------------
  test('running Tests card with no prior run shows the "starting" placeholder', async ({
    page,
  }) => {
    await stubOverviewRoutes(page, {
      jobs: () => [makeJob('test', 'running', { id: 'test-first-run', started_at: now() - 180 })],
    });

    await page.goto(`/project/${PROJECT}`);

    // No finished test exists yet -> StartingDetail placeholder, not a timestamp.
    const card = page.getByRole('button', { name: /Tests\s+running\s+starting/i });
    await expect(card).toBeVisible({ timeout: 8_000 });
    await expect(card).toBeEnabled();
    await expect(page.getByRole('button', { name: /Tests\s+running\s+started\s+\d/i })).toHaveCount(0);
  });

  test('running Tests card with a prior finished run shows a timed "started" detail, not the placeholder', async ({
    page,
  }) => {
    const priorTest = makeJob('test', 'done', {
      id: 'test-prior-finished',
      started_at: now() - 900,
      finished_at: now() - 840,
    });
    const runningTest = makeJob('test', 'running', {
      id: 'test-currently-running',
      started_at: now() - 180,
      finished_at: null,
    });

    await stubOverviewRoutes(page, { jobs: () => [runningTest, priorTest] });

    await page.goto(`/project/${PROJECT}`);

    // A prior finished test exists -> the running card shows the live job's real
    // start time ("started 3m ago"), never the transient "starting" placeholder.
    const timed = page.getByRole('button', { name: /Tests\s+running\s+started\s+3m ago/i });
    await expect(timed).toBeVisible({ timeout: 8_000 });
    await expect(timed).toBeEnabled();
    await expect(page.getByRole('button', { name: /Tests\s+running\s+starting/i })).toHaveCount(0);

    // The timed detail derives from the running job, so its click target is the
    // running job — not the stale finished one.
    await timed.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('job'), { timeout: 8_000 })
      .toBe('test-currently-running');
  });

  // -------------------------------------------------------------------------
  // Review card — placeholder vs timed detail
  // -------------------------------------------------------------------------
  test('running Review card with no prior run shows the "starting" placeholder', async ({
    page,
  }) => {
    await stubOverviewRoutes(page, {
      jobs: () => [makeJob('review', 'running', { id: 'review-first-run', started_at: now() - 180 })],
    });

    await page.goto(`/project/${PROJECT}`);

    const card = page.getByRole('button', { name: /Review\s+running\s+starting/i });
    await expect(card).toBeVisible({ timeout: 8_000 });
    await expect(card).toBeEnabled();
    await expect(page.getByRole('button', { name: /Review\s+running\s+started\s+\d/i })).toHaveCount(0);
  });

  test('running Review card with a prior finished run shows a timed "started" detail, not the placeholder', async ({
    page,
  }) => {
    // The prior review must carry a verdict so it qualifies as `latestReview`
    // (the page derives latestReview from finished review jobs with a verdict).
    const priorReview = makeJob('review', 'done', {
      id: 'review-prior-finished',
      started_at: now() - 900,
      finished_at: now() - 840,
      verdict: 'LGTM',
    });
    const runningReview = makeJob('review', 'running', {
      id: 'review-currently-running',
      started_at: now() - 180,
      finished_at: null,
    });

    await stubOverviewRoutes(page, { jobs: () => [runningReview, priorReview] });

    await page.goto(`/project/${PROJECT}`);

    const timed = page.getByRole('button', { name: /Review\s+running\s+started\s+3m ago/i });
    await expect(timed).toBeVisible({ timeout: 8_000 });
    await expect(timed).toBeEnabled();
    await expect(page.getByRole('button', { name: /Review\s+running\s+starting/i })).toHaveCount(0);

    await timed.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('job'), { timeout: 8_000 })
      .toBe('review-currently-running');
  });
});
