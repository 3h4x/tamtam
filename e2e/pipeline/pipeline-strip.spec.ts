import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// PipelineStrip UI tests — use the 1338 test server with mocked API responses
// to verify that the pipeline strip in the Terminal tab appears when pipeline
// steps are running, shows the correct step labels, and disappears when idle.
// Also tests the JobsPauseToggle ARIA state in the header.

const PROJECT = 'pipeline-strip-ui';

const BASE_TASK = {
  id: `${PROJECT}-1`,
  project: PROJECT,
  job: null,
  priority: null,
  launchctl: 'running',
  path: `/tmp/${PROJECT}`,
  fires_at: '',
  sync: true,
  changes: 5,
  unpushed: 0,
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

type MockJob = {
  id: string;
  project: string;
  kind: string;
  status: 'running' | 'done';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  verdict?: string;
  session_id?: string;
  pid?: number;
  log_path?: string;
  seen?: boolean;
};

function makeJob(
  overrides: Partial<MockJob> &
    Pick<MockJob, 'id' | 'kind' | 'status' | 'exit_code' | 'started_at' | 'finished_at'>,
): MockJob {
  return {
    project: PROJECT,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  };
}

async function mockScenario(
  page: import('@playwright/test').Page,
  jobs: MockJob[],
  settingsOverride?: Record<string, unknown>,
): Promise<void> {
  await page.route('**/api/projects', (route: Route) => {
    route.fulfill({
      json: {
        tasks: [BASE_TASK],
        priorities: [],
        issueCounts: {},
      },
    });
  });

  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      route.fulfill({ json: { jobs, pendingReleaseProjects: [] } });
    },
  );

  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) => {
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
        },
      });
    },
  );

  await page.route(
    `**/api/projects/by-project/${PROJECT}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
  );
  await page.route(
    `**/api/agents?project=${PROJECT}`,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/branch`,
    (route: Route) =>
      route.fulfill({
        json: { branch: 'master', defaultBranch: 'master', commitsAhead: null },
      }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/issues`,
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: settingsOverride ?? { settings: { jobs_paused: 'false' } } }),
  );
  // TerminalTab fetches skills and personas on mount.
  await page.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  );
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  );
}

const now = () => Math.floor(Date.now() / 1000);

test.describe('PipelineStrip visibility', () => {
  // ---------------------------------------------------------------------------
  // Strip visible when review is running
  // ---------------------------------------------------------------------------
  test('pipeline strip shows step labels when a review job is running', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'strip-review-running',
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 10,
        finished_at: null,
        session_id: 'sess-strip-1',
      }),
    ];
    await mockScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/terminal`);

    // The strip renders step labels as text inside button/div chips.
    // 'review' chip is present and shown as running (title hint is distinctive).
    await expect(
      page.getByTitle('review in progress — click to open terminal'),
    ).toBeVisible({ timeout: 8_000 });

    // Downstream pending steps must also be rendered.
    await expect(page.getByText('fix').first()).toBeVisible();
    await expect(page.getByText('commit').first()).toBeVisible();
    await expect(page.getByText('push').first()).toBeVisible();

    // The abort button is unique to the strip.
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Strip absent when no pipeline steps are running
  // ---------------------------------------------------------------------------
  test('pipeline strip is absent from terminal tab when no pipeline steps are running', async ({
    page,
  }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'strip-push-done',
        kind: 'push',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 60,
      }),
    ];
    await mockScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/terminal`);

    // PipelineStrip returns null — the abort button must not appear.
    await expect(page.getByRole('button', { name: 'abort' })).not.toBeVisible({
      timeout: 5_000,
    });
  });

  // ---------------------------------------------------------------------------
  // Strip shows doneCount / totalSteps progress indicator
  // ---------------------------------------------------------------------------
  test('pipeline strip progress counter reflects running step position', async ({ page }) => {
    // review is running (index 0 of rendered steps since no test command),
    // fix/commit/push are pending — doneCount = 0, totalSteps = 4.
    const jobs: MockJob[] = [
      makeJob({
        id: 'strip-review-prog',
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 5,
        finished_at: null,
        session_id: 'sess-strip-prog',
      }),
    ];
    await mockScenario(page, jobs);
    await page.goto(`/project/${PROJECT}/terminal`);

    // Progress counter is rendered as "doneCount/totalSteps".
    // With no test command: 4 steps (review, fix, commit, push); 0 done.
    await expect(page.getByText('0/4')).toBeVisible({ timeout: 8_000 });
  });

  // ---------------------------------------------------------------------------
  // Strip shows "confirm abort" prompt on first click of abort button
  // ---------------------------------------------------------------------------
  test('pipeline strip shows abort confirmation on first click', async ({ page }) => {
    const jobs: MockJob[] = [
      makeJob({
        id: 'strip-abort-confirm',
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 15,
        finished_at: null,
        session_id: 'sess-strip-abort',
      }),
    ];
    // The abort POST goes to the real server; mock it to avoid affecting state.
    await mockScenario(page, jobs);
    await page.route(
      `**/api/projects/by-project/${PROJECT}/release/abort`,
      (route: Route) => route.fulfill({ json: { status: 'no_active_pipeline' } }),
    );
    await page.goto(`/project/${PROJECT}/terminal`);

    // Wait for strip to be visible.
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible({
      timeout: 8_000,
    });

    // First click sets confirmAbort = true, which swaps the abort button for
    // the "abort? yes / no" confirmation row.
    await page.getByRole('button', { name: 'abort' }).click();
    await expect(page.getByText('abort?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'yes', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'no', exact: true })).toBeVisible();

    // Clicking "no" dismisses the confirmation and restores the abort button.
    await page.getByRole('button', { name: 'no', exact: true }).click();
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible();
  });
});

test.describe('JobsPauseToggle ARIA state', () => {
  // ---------------------------------------------------------------------------
  // Toggle shows unpaused state (aria-checked=false) by default
  // ---------------------------------------------------------------------------
  test('pause toggle is unchecked when jobs_paused is false', async ({ page }) => {
    await mockScenario(page, [], { settings: { jobs_paused: 'false' } });
    await page.goto(`/project/${PROJECT}/terminal`);

    // Aria-label changes: "Pause jobs" (running) or "Jobs paused — click to resume" (paused).
    const toggle = page.getByRole('switch', { name: /pause jobs|jobs paused/i });
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  // ---------------------------------------------------------------------------
  // Toggle shows paused state (aria-checked=true) when jobs are paused
  // ---------------------------------------------------------------------------
  test('pause toggle is checked when jobs_paused is true', async ({ page }) => {
    await mockScenario(page, [], { settings: { jobs_paused: 'true' } });
    await page.goto(`/project/${PROJECT}/terminal`);

    // Aria-label changes: "Pause jobs" (running) or "Jobs paused — click to resume" (paused).
    const toggle = page.getByRole('switch', { name: /pause jobs|jobs paused/i });
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});
