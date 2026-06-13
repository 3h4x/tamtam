import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// When an agent run POST returns 409 with { code: 'already_running' } — because
// THIS SAME agent is already running for the project — the AgentsTab must show
// an ERROR toast carrying the server's "already running" detail, NOT navigate
// to the terminal, and re-enable the Run button.
//
// This is the duplicate-protection counterpart to the queued case
// (agents-tab-queued-run-ui.spec.ts, a 202 success toast) and the paused gate
// (agents-tab-paused-gate-ui.spec.ts, a disabled button). The three job-start
// rejections must be visually distinct: success (role=status) for queued,
// error (role=alert) for a true duplicate, disabled button for global pause.
// All HTTP calls are mocked; no real agent spawns.

const PROJECT = 'agents-tab-duplicate-run-ui';
const AGENT_ID = 'agent-duplicate-run-ui-1';
const AGENT_NAME = 'Duplicate Run Agent';

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

test.describe('Agents tab duplicate-run UI', () => {
  test('clicking Run when the same agent is already running shows an error toast and stays on the page', async ({
    page,
  }) => {
    let runCallCount = 0;
    const duplicateDetail = `Agent '${AGENT_NAME}' is already running (job dup-run-job-7)`;

    await stubAgentsTabRoutes(page, () => { runCallCount += 1; }, {
      status: 409,
      body: { code: 'already_running', detail: duplicateDetail },
    });

    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });

    const runButton = row.getByRole('button', { name: 'Run', exact: true });
    await expect(runButton).toBeVisible();
    await expect(runButton).toBeEnabled();

    const initialUrl = page.url();

    await runButton.click();

    // The rejection surfaces as an ERROR toast (role=alert) carrying the
    // server's "already running" detail — distinct from the queued success
    // toast (role=status).
    const errorToast = page.getByRole('alert').filter({ hasText: 'already running' });
    await expect(errorToast).toBeVisible({ timeout: 5_000 });
    await expect(errorToast).toHaveText(duplicateDetail);

    // No success toast was shown for this rejection.
    await expect(page.getByRole('status').filter({ hasText: /started|queued/i })).toHaveCount(0);

    // Must NOT navigate to the terminal — URL stays on the agents tab.
    await expect(page).toHaveURL(initialUrl);

    // The POST was sent exactly once.
    expect(runCallCount).toBe(1);

    // Run button re-enables after the submit cycle completes so a later retry
    // is possible.
    await expect(runButton).toBeEnabled({ timeout: 5_000 });
  });
});
