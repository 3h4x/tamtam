import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for the project-overview StatusStrip *Review* card. Like the
// Tests card, the Review card is derived from /api/jobs: `isReviewRunning` (a
// running `review` job) and `latestReview` (the latest finished `review` job that
// carries a verdict). The verdict drives the card tone/label. This flips the
// stubbed jobs payload across the 5s jobs poll to cover the transitions that had
// no e2e:
//   1. a running review job (no prior verdict) -> "Review running starting" (warning, pulse)
//   2. review done LGTM            -> "Review LGTM" (success, clickable -> opens job)
//   3. review done NEEDS ATTENTION -> "Review NEEDS ATTENTION" (warning, clickable)
//   4. review done DO NOT SHIP     -> "Review DO NOT SHIP" (error, clickable)

const PROJECT = 'status-strip-review-ui';
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

function makeReviewJob(
  status: 'running' | 'done',
  verdict: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'review-job-1',
    project: PROJECT,
    kind: 'review',
    status,
    exit_code: status === 'done' ? 0 : null,
    verdict,
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
    route.fulfill({
      json: { tasks: [makeTask()], priorities: [], issueCounts: {} },
    }),
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
  await page.route(
    `**/api/projects/by-project/${PROJECT}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
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
  await page.route(
    `**/api/projects/by-project/${PROJECT}/branch`,
    (route: Route) =>
      route.fulfill({
        json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 },
      }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: { settings: { jobs_paused: 'false' }, github_owner: '' },
    }),
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
      route.fulfill({
        json: { jobs: opts.jobs(), pendingReleaseProjects: [] },
      }),
  );
}

test.describe('Overview StatusStrip Review card lifecycle', () => {
  test('advances from running to LGTM without reload', async ({ page }) => {
    let reviewRunning = true;
    await stubOverviewRoutes(page, {
      jobs: () =>
        reviewRunning
          ? [makeReviewJob('running', null)]
          : [makeReviewJob('done', 'LGTM')],
    });

    await page.goto(`/project/${PROJECT}`);
    const stablePath = new URL(page.url()).pathname;

    // A running review job with no prior verdict -> "running" + "starting".
    const running = page.getByRole('button', { name: /Review\s+running\s+starting/i });
    await expect(running).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /Review\s+LGTM/i })).toHaveCount(0);

    // Job finishes with an LGTM verdict -> the 5s jobs poll flips the card.
    reviewRunning = false;

    const lgtm = page.getByRole('button', { name: /Review\s+LGTM/i });
    await expect(lgtm).toBeVisible({ timeout: 12_000 });
    await expect(lgtm).toBeEnabled();
    await expect(page.getByRole('button', { name: /Review\s+running/i })).toHaveCount(0);
    // No client-side navigation happened during the live transition.
    await expect.poll(() => new URL(page.url()).pathname).toBe(stablePath);
  });

  test('shows DO NOT SHIP (error tone) when the review verdict blocks shipping', async ({ page }) => {
    let reviewRunning = true;
    await stubOverviewRoutes(page, {
      jobs: () =>
        reviewRunning
          ? [makeReviewJob('running', null)]
          : [makeReviewJob('done', 'DO NOT SHIP')],
    });

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByRole('button', { name: /Review\s+running/i })).toBeVisible({
      timeout: 8_000,
    });

    reviewRunning = false;

    const blocked = page.getByRole('button', { name: /Review\s+DO NOT SHIP/i });
    await expect(blocked).toBeVisible({ timeout: 12_000 });
    await expect(blocked).toBeEnabled();
    await expect(page.getByRole('button', { name: /Review\s+LGTM/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Review\s+running/i })).toHaveCount(0);
  });

  test('shows NEEDS ATTENTION when the review verdict flags follow-up', async ({ page }) => {
    let reviewRunning = true;
    await stubOverviewRoutes(page, {
      jobs: () =>
        reviewRunning
          ? [makeReviewJob('running', null)]
          : [makeReviewJob('done', 'NEEDS ATTENTION')],
    });

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByRole('button', { name: /Review\s+running/i })).toBeVisible({
      timeout: 8_000,
    });

    reviewRunning = false;

    await expect(
      page.getByRole('button', { name: /Review\s+NEEDS ATTENTION/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /Review\s+LGTM/i })).toHaveCount(0);
  });
});
