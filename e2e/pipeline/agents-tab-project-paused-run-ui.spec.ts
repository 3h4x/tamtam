import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// When an agent run POST returns 409 with { code: 'project_paused' } — because
// the project itself is paused rather than the global jobs pause — the AgentsTab
// must show an ERROR toast carrying the server's project-paused detail, NOT
// navigate to the terminal, and re-enable the Run button.
//
// This is distinct from the three sibling rejection cases:
//   - agents-tab-paused-gate-ui.spec.ts   → global pause: button DISABLED before POST
//   - agents-tab-queued-run-ui.spec.ts     → 202 queued: SUCCESS toast, no nav
//   - agents-tab-duplicate-run-ui.spec.ts  → 409 already_running: error toast
//
// Per-project pause is different because agentRunsBlocked only watches global
// jobs_paused. The button is ENABLED and the POST is sent; the server rejects
// with project_paused; the catch block converts data.detail to the error toast.
// Both error toasts use role="alert" but carry different detail text — this spec
// pins the project_paused message specifically.
//
// All HTTP calls are mocked; no real agent spawns.

const PROJECT = 'agents-tab-project-paused-run-ui';
const AGENT_ID = 'agent-project-paused-run-ui-1';
const AGENT_NAME = 'Project-Paused Agent';

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
): Promise<void> {
  // Global pause is OFF — button must be enabled; per-project pause comes from
  // the server 409, not from a pre-flight disable.
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
        // Global pause is off — only per-project pause blocks this run
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
    return route.fulfill({
      status: 409,
      json: {
        code: 'project_paused',
        detail: `Project '${PROJECT}' is paused — agent runs are blocked. Resume on the project page to continue.`,
      },
    });
  });
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

function agentRow(page: Page) {
  return page.locator('tbody tr').filter({ hasText: AGENT_NAME }).first();
}

test.describe('Agents tab project-paused run UI', () => {
  test('clicking Run when the project is paused shows a project-paused error toast and stays on the page', async ({
    page,
  }) => {
    let runCallCount = 0;
    const projectPausedDetail = `Project '${PROJECT}' is paused — agent runs are blocked. Resume on the project page to continue.`;

    await stubAgentsTabRoutes(page, () => { runCallCount += 1; });
    await page.goto(`/project/${PROJECT}/agents`);

    const row = agentRow(page);
    await expect(row).toBeVisible({ timeout: 8_000 });

    const runButton = row.getByRole('button', { name: 'Run', exact: true });
    await expect(runButton).toBeVisible();
    // Global pause is off → button must be ENABLED (unlike agents-tab-paused-gate-ui)
    await expect(runButton).toBeEnabled();

    const initialUrl = page.url();

    await runButton.click();

    // The POST was sent (button was enabled — per-project pause is server-side)
    expect(runCallCount).toBe(1);

    // The server rejection surfaces as an ERROR toast (role=alert) carrying the
    // specific project-paused message.
    const errorToast = page.getByRole('alert').filter({ hasText: 'is paused' });
    await expect(errorToast).toBeVisible({ timeout: 5_000 });
    await expect(errorToast).toHaveText(projectPausedDetail);

    // Must NOT show a success/queued toast.
    await expect(page.getByRole('status').filter({ hasText: /started|queued/i })).toHaveCount(0);

    // Must NOT navigate — URL stays on the agents tab.
    await expect(page).toHaveURL(initialUrl);

    // Run button re-enables after the submit cycle so the user can try again
    // after resuming the project.
    await expect(runButton).toBeEnabled({ timeout: 5_000 });
  });
});
