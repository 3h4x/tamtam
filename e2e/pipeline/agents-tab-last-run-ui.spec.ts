import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'agents-last-run-ui';
const AGENT_ID = 'agent-last-run-ui-1';
const AGENT_NAME = 'Lifecycle Agent';

const now = () => Math.floor(Date.now() / 1000);

type MockJob = {
  id: string;
  project: string;
  kind: string;
  status: 'running' | 'done';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  pid: number;
  log_path: string;
  seen: boolean;
  session_id: string | null;
  parent_job_id: string | null;
  parent_kind: string | null;
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

function makeAgent() {
  return {
    id: AGENT_ID,
    name: AGENT_NAME,
    project: PROJECT,
    skillIds: [],
    docPaths: [],
    model: 'claude-sonnet-4',
    prompt: 'Check lifecycle UI',
    schedule: null,
    enabled: true,
    boostable: true,
    provider: null,
    fallbackEnabled: false,
    prerequisiteCommand: null,
    permissionMode: null,
    createdAt: now() - 3600,
    updatedAt: now() - 3600,
    source: 'db',
    kind: 'user',
    cron: null,
    lastAttempt: null,
  };
}

function makeFinishedAgentJob(exitCode: number): MockJob {
  return makeAgentJob('done', exitCode);
}

function makeAgentJob(status: 'running' | 'done', exitCode: number | null): MockJob {
  return {
    id: `job-agent-${status}-${exitCode ?? 'live'}`,
    project: PROJECT,
    kind: `agent:${AGENT_NAME}`,
    status,
    exit_code: exitCode,
    started_at: now() - 45,
    finished_at: status === 'done' ? now() - 5 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    parent_job_id: null,
    parent_kind: null,
  };
}

function agentRow(page: Page) {
  return page.locator('tbody tr').filter({ hasText: AGENT_NAME }).first();
}

async function stubProjectShellRoutes(page: Page): Promise<void> {
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
  await page.route(`**/api/projects/by-project/${PROJECT}/issues?summary=1`, (route: Route) =>
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
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [makeAgent()] } }),
  );
  await page.route('**/api/skills', (route: Route) => route.fulfill({ json: { skills: [] } }));
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  );
  await page.route('**/api/agents/scheduler-health', (route: Route) =>
    route.fulfill({ json: { internal: { entries: [] } } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: { settings: { jobs_paused: 'false', agent_templates: '[]' }, github_owner: '' },
    }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

test.describe('Agents tab last-run lifecycle UI', () => {
  test('last-run cell updates from never to failed without a page reload', async ({ page }) => {
    let phase: 'never-run' | 'failed' = 'never-run';

    await stubProjectShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs = phase === 'failed' ? [makeFinishedAgentJob(2)] : [];
        route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } });
      },
    );

    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.getByText('never', { exact: true })).toBeVisible();

    phase = 'failed';

    await expect(row.getByText('just now')).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('span[title^="Failed"]')).toBeVisible();
    await expect(row.getByText('never', { exact: true })).toHaveCount(0);
  });

  test('last-run cell clears running state when an agent run is cancelled without reload', async ({
    page,
  }) => {
    let phase: 'running' | 'cancelled' = 'running';

    await stubProjectShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs = [
          phase === 'running'
            ? makeAgentJob('running', null)
            : makeAgentJob('done', -2),
        ];
        route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } });
      },
    );

    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.getByText('running', { exact: true })).toBeVisible();
    await expect(row.locator('span[title^="Running"]')).toBeVisible();

    phase = 'cancelled';

    await expect(row.locator('span[title^="Cancelled"]')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0);
    await expect(row.locator('span[title^="Failed"]')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Agents tab — never-run → succeeded
  //
  // The cell must transition directly from "never" to "Ran X ago" when a
  // completed job (exit_code 0) first appears — without an intermediate
  // "running" state being visible. This differs from the running→succeeded
  // path in that the UI polls from an empty job list straight to a finished
  // one, exercising the branch where lastRunJob is initially null.
  // -------------------------------------------------------------------------
  test('last-run cell goes from "never" to "Ran" when a succeeded job first appears without reload', async ({
    page,
  }) => {
    let phase: 'never-run' | 'succeeded' = 'never-run';

    await stubProjectShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs = phase === 'succeeded' ? [makeAgentJob('done', 0)] : [];
        route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } });
      },
    );

    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.getByText('never', { exact: true })).toBeVisible();
    // No running badge in the initial state.
    await expect(row.locator('span[title^="Running"]')).toHaveCount(0);

    phase = 'succeeded';

    // Cell must flip to "Ran X ago" without any intermediate running state.
    await expect(row.locator('span[title^="Ran"]')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText('just now')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText('never', { exact: true })).toHaveCount(0);
    await expect(row.locator('span[title^="Failed"]')).toHaveCount(0);
    await expect(row.locator('span[title^="Cancelled"]')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Agents tab — running → succeeded
  //
  // The component computes the last-run span title as:
  //   running → "Running · started X ago"
  //   cancelled → "Cancelled · X ago"
  //   failed → "Failed · X ago"
  //   succeeded → "Ran X ago"
  //
  // The existing tests cover never→failed and running→cancelled. This test
  // covers the success path (exit_code 0): the running badge must clear and the
  // span title must change to "Ran …" — neither "Failed" nor "Cancelled" should
  // appear, and the row must not require a page reload to reflect the change.
  // -------------------------------------------------------------------------
  test('last-run cell clears running state and shows "Ran" when an agent run succeeds without reload', async ({
    page,
  }) => {
    let phase: 'running' | 'succeeded' = 'running';

    await stubProjectShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs = [
          phase === 'running'
            ? makeAgentJob('running', null)
            : makeAgentJob('done', 0),
        ];
        route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } });
      },
    );

    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });
    await expect(row.getByText('running', { exact: true })).toBeVisible();
    await expect(row.locator('span[title^="Running"]')).toBeVisible();

    phase = 'succeeded';

    // Title flips from "Running · …" to "Ran X ago"; "just now" is the
    // relative-time label shown inside the span (job finished ~5 s ago).
    await expect(row.locator('span[title^="Ran"]')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText('just now')).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText('running', { exact: true })).toHaveCount(0);
    await expect(row.locator('span[title^="Failed"]')).toHaveCount(0);
    await expect(row.locator('span[title^="Cancelled"]')).toHaveCount(0);
  });
});
