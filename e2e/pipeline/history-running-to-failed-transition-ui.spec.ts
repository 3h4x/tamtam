import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Mocked-API dynamic lifecycle test for the history tab.
//
// This spec pins a specific gap: when the /api/jobs poll returns a running job
// and then returns the same job in a failed state (exit_code=1), the history
// tab must update the status badge from "running" to "exit 1" WITHOUT a page
// reload and WITHOUT leaving an orphaned spinner.
//
// This is the mocked counterpart to the real-pipeline tests in
// history-live-lifecycle.spec.ts. It doesn't rely on a Claude shim or PM2.

const PROJECT = 'history-running-to-failed-ui';
const RUN_PROMPT = 'Run that transitions from running to failed in the history tab.';
const RUN_SUMMARY = 'Build error encountered during execution.';

const now = () => Math.floor(Date.now() / 1000);

function makeTask() {
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
  };
}

function makeRunJob(phase: 'running' | 'failed') {
  const running = phase === 'running';
  return {
    id: 'history-running-to-failed-run-1',
    project: PROJECT,
    kind: 'test',
    prompt: RUN_PROMPT,
    user_prompt: RUN_PROMPT,
    work_summary: running ? 'Test suite executing.' : RUN_SUMMARY,
    session_id: 'sess-history-running-to-failed',
    status: running ? 'running' : 'done',
    exit_code: running ? null : 1,
    started_at: now() - 60,
    finished_at: running ? null : now() - 5,
    seen: true,
    pid: running ? 9999 : 0,
    log_path: '',
  };
}

async function stubHistoryShell(page: Page, getPhase: () => 'running' | 'failed'): Promise<void> {
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
        tests_disabled: true,
        review_disabled: false,
        issue_auto_branch: false,
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
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const job = makeRunJob(getPhase());
      route.fulfill({ json: { jobs: [job], total: 1, pendingReleaseProjects: [] } });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const running = getPhase() === 'running';
      route.fulfill({
        json: {
          total: 1,
          byKind: { test: 1 },
          byStatus: {
            running: running ? 1 : 0,
            done: running ? 0 : 1,
            aborted: 0,
            failed: running ? 0 : 1,
          },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      });
    },
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
}

test.describe('History tab: running job transitions to failed via poll', () => {
  test('running badge flips to "exit 1" on the next poll without page reload', async ({ page }) => {
    let phase: 'running' | 'failed' = 'running';

    await stubHistoryShell(page, () => phase);
    await page.goto(`/project/${PROJECT}/history`);

    // Phase 1: job is running → running badge visible.
    const row = page.getByRole('button').filter({ hasText: RUN_PROMPT }).first();
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.getByLabel('running')).toBeVisible({ timeout: 8_000 });

    const stableUrl = page.url();

    // Flip to failed on the next poll.
    phase = 'failed';

    // Phase 2: running badge clears; "exit 1" badge appears.
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 15_000 });

    // The failed work_summary should also appear.
    await expect(row.getByText(RUN_SUMMARY, { exact: false })).toBeVisible({ timeout: 8_000 });

    // No page reload occurred.
    await expect(page).toHaveURL(stableUrl);
  });

  test('running filter clears when the only running job fails via poll', async ({ page }) => {
    let phase: 'running' | 'failed' = 'running';

    await stubHistoryShell(page, () => phase);
    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button').filter({ hasText: RUN_PROMPT }).first();
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.getByLabel('running')).toBeVisible();

    // Activate the "running" filter so only running rows are shown.
    const runningFilter = page.getByRole('button', { name: /running/i }).first();
    await expect(runningFilter).toBeVisible();
    await runningFilter.click();

    // The row should still be visible since it's running.
    await expect(row).toBeVisible({ timeout: 5_000 });

    phase = 'failed';

    // After the poll, the running filter should show no rows (the job is done).
    await expect(row.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
  });
});
