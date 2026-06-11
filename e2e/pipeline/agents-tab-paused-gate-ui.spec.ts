import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// E2E coverage for the global pause gate on the Agents tab "Run" buttons
// (components/AgentsTab.tsx). Starting an agent run is exactly the kind of
// job-start the global `jobs_paused` gate exists to stop — the server's
// POST /api/agents/[agentId]/run returns 409 jobs_paused when paused. Every
// sibling job-start surface disables itself when jobs are paused; the Agents
// tab follows the same contract. This spec pins that the Run button is
// disabled with the paused reason and a paused banner is shown when jobs are
// paused, and enabled (no banner) when they are not.
//
// All HTTP calls are mocked — no real agent process is spawned and no
// global-setup project registration is needed.

const PROJECT = 'agents-paused-gate-ui';
const AGENT_ID = 'agent-paused-gate-ui-1';
const AGENT_NAME = 'Gate Agent';

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

function makeAgent() {
  return {
    id: AGENT_ID,
    name: AGENT_NAME,
    project: PROJECT,
    skillIds: [],
    docPaths: [],
    model: 'claude-sonnet-4',
    prompt: 'Do the thing',
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

interface MockOpts {
  jobsPaused: boolean;
  // Records any POST to the agent run route so the test can prove a paused
  // click sends nothing.
  onRun?: () => void;
}

async function stubProjectShellRoutes(page: Page, opts: MockOpts): Promise<void> {
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
      json: {
        settings: { jobs_paused: opts.jobsPaused ? 'true' : 'false', agent_templates: '[]' },
        github_owner: '',
      },
    }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  );
  await page.route(`**/api/agents/${AGENT_ID}/run`, (route: Route) => {
    opts.onRun?.();
    return route.fulfill({ json: { status: 'started', job_id: 'job-should-not-happen' } });
  });
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

function agentRow(page: Page) {
  return page.locator('tbody tr').filter({ hasText: AGENT_NAME }).first();
}

test.describe('Agents tab global-pause gate UI', () => {
  // -------------------------------------------------------------------------
  // Test 1: jobs paused → Run disabled with paused reason, banner shown, no POST
  // -------------------------------------------------------------------------
  test('Run is disabled with the paused reason and shows a banner when jobs are paused', async ({
    page,
  }) => {
    let runCalls = 0;
    await stubProjectShellRoutes(page, { jobsPaused: true, onRun: () => { runCalls += 1; } });
    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });

    const run = row.getByRole('button', { name: 'Run', exact: true });
    await expect(run).toBeVisible();
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute(
      'title',
      'Jobs are paused globally. Resume jobs in Settings to run agents.',
    );

    // The paused banner above the table mirrors the same reason.
    await expect(
      page.getByText('Jobs are paused globally. Resume jobs in Settings to run agents.'),
    ).toBeVisible();

    // A disabled button must not fire the outbound run. force-click to prove
    // the gate holds even if the DOM disabled state were bypassed.
    await run.click({ force: true }).catch(() => {});
    expect(runCalls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 2: jobs running → Run enabled, no banner (control)
  // -------------------------------------------------------------------------
  test('Run is enabled and no paused banner is shown when jobs are running', async ({ page }) => {
    await stubProjectShellRoutes(page, { jobsPaused: false });
    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });

    const run = row.getByRole('button', { name: 'Run', exact: true });
    await expect(run).toBeVisible();
    await expect(run).toBeEnabled();

    await expect(
      page.getByText('Jobs are paused globally. Resume jobs in Settings to run agents.'),
    ).toHaveCount(0);
  });
});
