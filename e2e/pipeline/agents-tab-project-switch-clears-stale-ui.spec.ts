import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Pure page.route() UI spec. Verifies that when navigating between projects on
// the agents tab, the old project's agent list clears immediately — it must not
// linger while the destination project's agents request is still pending.
// Covers the stale-state bug where AgentsTab.loadData() did not reset loading=true
// on projectName change, causing the old agents list to remain visible.

const PROJECT_A = 'agents-switch-source';
const PROJECT_B = 'agents-switch-target';
const AGENT_A_NAME = 'Alpha Analyzer';
const AGENT_B_NAME = 'Beta Reviewer';

const now = () => Math.floor(Date.now() / 1000);

type MockAgent = {
  id: string;
  name: string;
  project: string;
  skillIds: string[];
  docPaths: string[];
  model: string;
  prompt: string;
  schedule: null;
  enabled: boolean;
  boostable: boolean;
  provider: null;
  fallbackEnabled: boolean;
  prerequisiteCommand: null;
  permissionMode: null;
  createdAt: number;
  updatedAt: number;
  source: string;
  kind: string;
  cron: null;
  lastAttempt: null;
};

function makeTask(project: string) {
  return {
    id: `${project}-1`,
    project,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${project}`,
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

function makeProjectConfig(project: string) {
  return {
    project,
    test_command: '',
    release_timeout_minutes: null,
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
    website: '',
    qa_url: '',
  };
}

function makeAgent(project: string, name: string, id: string): MockAgent {
  return {
    id,
    name,
    project,
    skillIds: [],
    docPaths: [],
    model: 'claude-sonnet-4',
    prompt: `Run ${name} for ${project}`,
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

async function clickClientRoute(page: Page, href: string): Promise<void> {
  await page.evaluate((targetHref) => {
    const anchor = document.createElement('a');
    anchor.href = targetHref;
    anchor.textContent = 'switch project';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, href);
}

async function stubAgentsTabShell(
  page: Page,
  opts: {
    agentsA: MockAgent[];
    agentsB: MockAgent[];
    releaseAgentsB: () => void;
    agentsBReady: Promise<void>;
  },
): Promise<void> {
  const projects = [PROJECT_A, PROJECT_B];

  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: projects.map(makeTask), priorities: [], issueCounts: {} },
    }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  );
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  );
  await page.route('**/api/agents/scheduler-health', (route: Route) =>
    route.fulfill({ json: { entries: [] } }),
  );

  for (const project of projects) {
    await page.route(`**/api/projects/by-project/${project}/config`, (route: Route) =>
      route.fulfill({ json: makeProjectConfig(project) }),
    );
    await page.route(`**/api/projects/by-project/${project}/action`, (route: Route) =>
      route.fulfill({ json: { actions: [] } }),
    );
    await page.route(`**/api/projects/by-project/${project}/branch`, (route: Route) =>
      route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
    );
    await page.route(`**/api/projects/by-project/${project}/behind`, (route: Route) =>
      route.fulfill({ json: { behind: 0, ahead: 0 } }),
    );
    await page.route(`**/api/projects/by-project/${project}/issues`, (route: Route) =>
      route.fulfill({ json: { prs: [], issues: [] } }),
    );
    await page.route(
      (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === project,
      (route: Route) => route.fulfill({ json: { items: [] } }),
    );
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === project,
      (route: Route) => route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
    );
    await page.route(
      (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === project,
      (route: Route) =>
        route.fulfill({
          json: {
            total: 0,
            byKind: {},
            byStatus: { running: 0, done: 0, aborted: 0, failed: 0 },
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
            cost: { total: 0, monthToDate: 0 },
          },
        }),
    );
  }

  // Project A agents: respond immediately
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT_A,
    (route: Route) => route.fulfill({ json: { agents: opts.agentsA } }),
  );

  // Project B agents: delayed response to expose the stale-state window
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT_B,
    async (route: Route) => {
      opts.releaseAgentsB();
      await opts.agentsBReady;
      await route.fulfill({ json: { agents: opts.agentsB } });
    },
  );
}

test.describe('AgentsTab project switch lifecycle state', () => {
  test('clears old project agent list while destination project agents request is pending', async ({
    page,
  }) => {
    const agentsA = [makeAgent(PROJECT_A, AGENT_A_NAME, 'agent-alpha-1')];
    const agentsB = [makeAgent(PROJECT_B, AGENT_B_NAME, 'agent-beta-1')];
    let agentsBRequested = false;
    let resolveAgentsB!: () => void;
    const agentsBReady = new Promise<void>((resolve) => {
      resolveAgentsB = resolve;
    });

    await stubAgentsTabShell(page, {
      agentsA,
      agentsB,
      agentsBReady,
      releaseAgentsB: () => {
        agentsBRequested = true;
      },
    });

    // Load project A's agents tab
    await page.goto(`/project/${PROJECT_A}/agents`);
    await expect(page.getByText(AGENT_A_NAME).first()).toBeVisible({ timeout: 8_000 });

    // Client-side navigate to project B's agents tab
    await clickClientRoute(page, `/project/${PROJECT_B}/agents`);
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT_B}/agents$`), { timeout: 8_000 });

    // Wait for the agents request to fire (confirms the component re-fetched)
    await expect.poll(() => agentsBRequested, { timeout: 8_000 }).toBe(true);

    // Project A's agent must not linger while project B's response is pending
    await expect(page.getByText(AGENT_A_NAME)).toHaveCount(0, { timeout: 8_000 });

    // Release project B's agents and verify they appear
    resolveAgentsB();
    await expect(page.getByText(AGENT_B_NAME).first()).toBeVisible({ timeout: 8_000 });
    // Confirm project A's agent is still absent
    await expect(page.getByText(AGENT_A_NAME)).toHaveCount(0);
  });
});
