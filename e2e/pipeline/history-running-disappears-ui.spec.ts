import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'history-running-disappears-ui';
const RUN_PROMPT = 'Run that disappears from the current history window';
const RUN_SUMMARY = 'Provider output is still streaming before retention removes the row';

const now = () => Math.floor(Date.now() / 1000);

type MockJob = {
  id: string;
  project: string;
  kind: string;
  prompt: string | null;
  user_prompt: string | null;
  work_summary: string | null;
  session_id: string | null;
  status: 'running' | 'done';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  seen: boolean;
  pid: number;
  log_path: string;
};

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

function runningJob(): MockJob {
  return {
    id: 'history-running-disappears-run-1',
    project: PROJECT,
    kind: 'run',
    prompt: RUN_PROMPT,
    user_prompt: RUN_PROMPT,
    work_summary: RUN_SUMMARY,
    session_id: 'sess-history-running-disappears',
    status: 'running',
    exit_code: null,
    started_at: now() - 30,
    finished_at: null,
    seen: true,
    pid: 0,
    log_path: '',
  };
}

async function stubHistoryShell(page: Page, getJobs: () => MockJob[]): Promise<void> {
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
      const jobs = getJobs();
      route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const jobs = getJobs();
      const running = jobs.filter((job) => job.status === 'running').length;
      route.fulfill({
        json: {
          total: jobs.length,
          byKind: jobs.length > 0 ? { run: jobs.length } : {},
          byStatus: {
            running,
            done: jobs.length - running,
            aborted: 0,
            failed: jobs.filter((job) => job.exit_code !== null && job.exit_code !== 0).length,
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

function runRow(page: Page) {
  return page.getByRole('button').filter({ hasText: RUN_PROMPT }).first();
}

test.describe('History running row disappears on refresh', () => {
  test('a backend total=0 refresh removes a previously running row and clears the spinner', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubHistoryShell(page, () => (serveRunning ? [runningJob()] : []));
    await page.goto(`/project/${PROJECT}/history`);

    const row = runRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.getByLabel('running')).toBeVisible();
    await expect(row.getByText(RUN_SUMMARY)).toBeVisible();
    await expect(page.getByRole('button', { name: /^running 1$/ })).toBeVisible();

    serveRunning = false;

    await expect(row).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /^running 1$/ })).toHaveCount(0);
    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByText('Start work from Terminal or trigger a release. New runs, verdicts, and durations will show up here.'),
    ).toBeVisible();
  });
});
