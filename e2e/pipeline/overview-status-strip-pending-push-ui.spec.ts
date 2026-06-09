import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-UI coverage for the project-overview StatusStrip when the project has
// pending uncommitted changes AND an unpushed commit. Every existing
// overview-live spec seeds `changes: 0`, so three StatusStrip branches had no
// e2e coverage at all:
//   1. the Review card's "LGTM · awaiting push" detail — the `pendingPush`
//      branch (verdict === 'LGTM' && totalChanges > 0) that signals the diff is
//      blessed but not yet on origin
//   2. the Push card ("N commits ahead · not yet pushed to origin"), which only
//      renders when unpushed > 0
//   3. the Changes card flipping between "unreviewed" (warning) and "reviewed"
//      (success) based on hasUnreviewed
//
// The review-running -> LGTM transition is driven entirely by the 5 s /api/jobs
// poll, so the test stays fast and deterministic; the task-level fields
// (changes/unpushed/reviewed) are held static via /api/projects.

const PROJECT = 'status-strip-pending-ui';
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
  id: string,
  kind: string,
  status: 'running' | 'done',
  exitCode: number | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    project: PROJECT,
    kind,
    status,
    exit_code: exitCode,
    started_at: now() - 60,
    finished_at: status === 'done' ? now() - 5 : null,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  };
}

async function stubOverviewRoutes(
  page: Page,
  opts: {
    taskOverrides?: Record<string, unknown>;
    jobs?: () => Array<Record<string, unknown>>;
  } = {},
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [makeTask(opts.taskOverrides)],
        priorities: [],
        issueCounts: {},
      },
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
        json: {
          jobs: opts.jobs ? opts.jobs() : [],
          pendingReleaseProjects: [],
        },
      }),
  );
}

test.describe('Overview StatusStrip pending-push lifecycle', () => {
  test('review running -> LGTM surfaces "awaiting push" while the Push card stays put', async ({
    page,
  }) => {
    // 2 uncommitted files (already reviewed so the Changes card is "reviewed"),
    // 1 local commit not yet on origin. A review job runs and then returns LGTM.
    let reviewRunning = true;
    await stubOverviewRoutes(page, {
      taskOverrides: { changes: 2, unpushed: 1, reviewed: true },
      jobs: () =>
        reviewRunning
          ? [makeJob('review-pending-live', 'review', 'running', null)]
          : [
              makeJob('review-pending-live', 'review', 'done', 0, {
                verdict: 'LGTM',
                session_id: 'sess-review-pending-live',
              }),
            ],
    });

    await page.goto(`/project/${PROJECT}`);

    // Changes + Push cards are present immediately (task-level, static).
    await expect(page.getByText('2 files')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('1 commit ahead')).toBeVisible({ timeout: 8_000 });

    // While the review runs, the Review card reads "running" and there is no
    // "awaiting push" hint yet.
    await expect(page.getByRole('button', { name: /review running/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(/awaiting push/i)).toHaveCount(0);

    // Review finishes LGTM -> the 5 s /api/jobs poll flips the card, and because
    // changes are still pending the detail must read "awaiting push".
    reviewRunning = false;

    await expect(page.getByRole('button', { name: /review LGTM/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText(/awaiting push/i)).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /review running/i })).toHaveCount(0);

    // The Push card never changed — the commit is still unpushed.
    await expect(page.getByText('1 commit ahead')).toBeVisible();
  });

  test('Changes card reads "unreviewed" (warning) when uncommitted edits are not yet reviewed', async ({
    page,
  }) => {
    // 3 uncommitted files, not reviewed, nothing pushed-behind. No running jobs.
    await stubOverviewRoutes(page, {
      taskOverrides: { changes: 3, unpushed: 0, reviewed: false },
      jobs: () => [],
    });

    await page.goto(`/project/${PROJECT}`);

    // Changes card surfaces the count and the unreviewed warning detail. Scope
    // to the Changes card button — "unreviewed" also appears as the Review
    // card's primary text, so a bare getByText would be ambiguous.
    const changesCard = page.getByRole('button', { name: /Changes 3 files unreviewed/i });
    await expect(changesCard).toBeVisible({ timeout: 8_000 });

    // With unreviewed edits and no review yet, the Review card invites a review
    // rather than showing a stale verdict, and there is no Push card.
    await expect(page.getByRole('button', { name: /review unreviewed/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(/commit.* ahead/i)).toHaveCount(0);
  });
});
