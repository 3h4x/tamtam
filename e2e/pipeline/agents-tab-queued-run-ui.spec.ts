import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// When an agent run POST returns 202 with { status: 'queued' } — because
// another agent for the same project is already running — the AgentsTab must:
//   1. Show a success toast mentioning "queued" (not navigate to the terminal).
//   2. Re-enable the Run button after the submit completes.
//
// This is distinct from the 409 jobs_paused gate (covered by
// agents-tab-paused-gate-ui.spec.ts) and from the 200 started case (which
// navigates to /terminal). All HTTP calls are mocked; no real agent spawns.

const PROJECT = 'agents-tab-queued-run-ui';
const AGENT_ID = 'agent-queued-run-ui-1';
const AGENT_NAME = 'Queued Run Agent';

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
    prompt: 'Check for regressions.',
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

async function stubAgentsTabRoutes(
  page: Page,
  onRunCall: () => void,
  runResponse: { status: number; body: object },
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
        settings: { jobs_paused: 'false', agent_templates: '[]' },
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
    onRunCall();
    return route.fulfill({ status: runResponse.status, json: runResponse.body });
  });
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

function agentRow(page: Page) {
  return page.locator('tbody tr').filter({ hasText: AGENT_NAME }).first();
}

test.describe('Agents tab queued-run UI', () => {
  test('clicking Run when queued shows a success toast and stays on the agents page', async ({
    page,
  }) => {
    let runCallCount = 0;
    const queuedDetail = 'Agent queued: another agent run is already in progress for this project.';

    await stubAgentsTabRoutes(page, () => { runCallCount += 1; }, {
      status: 202,
      body: { status: 'queued', detail: queuedDetail },
    });

    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });

    const runButton = row.getByRole('button', { name: 'Run', exact: true });
    await expect(runButton).toBeVisible();
    await expect(runButton).toBeEnabled();

    const initialUrl = page.url();

    await runButton.click();

    // Toast should appear with queued text (success tone, not error).
    await expect(page.getByText(/queued/i).first()).toBeVisible({ timeout: 5_000 });

    // Must NOT navigate to the terminal — URL stays on the agents tab.
    await expect(page).toHaveURL(initialUrl);

    // The POST was sent exactly once.
    expect(runCallCount).toBe(1);

    // Run button re-enables after the submit cycle completes.
    await expect(runButton).toBeEnabled({ timeout: 5_000 });
  });

  test('clicking Run when started navigates to the terminal', async ({ page }) => {
    let runCallCount = 0;
    const jobId = 'queued-run-ui-job-started-123';

    await stubAgentsTabRoutes(page, () => { runCallCount += 1; }, {
      status: 200,
      body: { status: 'started', job_id: jobId },
    });

    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });

    const runButton = row.getByRole('button', { name: 'Run', exact: true });
    await expect(runButton).toBeEnabled();

    await runButton.click();

    // Successful start → navigate to the terminal (URL contains the job ID).
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(jobId)), { timeout: 8_000 });
    expect(runCallCount).toBe(1);
  });
});
