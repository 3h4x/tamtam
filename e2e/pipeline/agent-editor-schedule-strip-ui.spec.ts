import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

const PROJECT = 'agent-editor-strip-ui';
const AGENT_ID = 'agent-strip-ui-1';
const AGENT_NAME = 'Strip Test Agent';

function makeAgent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: AGENT_ID,
    name: AGENT_NAME,
    project: PROJECT,
    skillIds: [],
    docPaths: [],
    model: 'claude-sonnet-4',
    prompt: 'Do something useful',
    schedule: null,
    enabled: true,
    boostable: true,
    provider: null,
    fallbackEnabled: false,
    prerequisiteCommand: null,
    permissionMode: null,
    createdAt: Math.floor(Date.now() / 1000) - 3600,
    updatedAt: Math.floor(Date.now() / 1000) - 3600,
    source: 'db',
    kind: 'user',
    cron: null,
    lastAttempt: null,
    ...overrides,
  };
}

async function stubRoutes(page: import('@playwright/test').Page, agentState: ReturnType<typeof makeAgent>) {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: {
        tasks: [{
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
        }],
        priorities: [],
        issueCounts: {},
      },
    }),
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
    route.fulfill({ json: { repo: '', issueCount: 0, prCount: 0, openPrBranches: [], error: null, cached: true, cachedAt: Date.now() } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [agentState] } }),
  );
  await page.route(
    (url) => url.pathname === `/api/agents/${AGENT_ID}`,
    (route: Route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: { agent: agentState } });
      }
      return route.continue();
    },
  );
  await page.route('**/api/skills', (route: Route) => route.fulfill({ json: { skills: [] } }));
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  );
  await page.route('**/api/agents/scheduler-health', (route: Route) =>
    route.fulfill({ json: { internal: { entries: [] } } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false', agent_templates: '[]' }, github_owner: '' } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

test.describe('Agent editor schedule strip UI', () => {
  test('Enabled toggle is checked for an enabled agent', async ({ page }) => {
    const agent = makeAgent({ enabled: true });
    await stubRoutes(page, agent);
    await page.goto(`/project/${PROJECT}/agents?agent=${AGENT_ID}`);

    const enabledSwitch = page.getByRole('switch', { name: 'Enabled' });
    await expect(enabledSwitch).toBeVisible({ timeout: 8_000 });
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
  });

  test('Boostable toggle is checked for a boostable agent', async ({ page }) => {
    const agent = makeAgent({ boostable: true });
    await stubRoutes(page, agent);
    await page.goto(`/project/${PROJECT}/agents?agent=${AGENT_ID}`);

    const boostableSwitch = page.getByRole('switch', { name: 'Boostable' });
    await expect(boostableSwitch).toBeVisible({ timeout: 8_000 });
    await expect(boostableSwitch).toHaveAttribute('aria-checked', 'true');
  });

  test('Enabled toggle reflects disabled agent', async ({ page }) => {
    const agent = makeAgent({ enabled: false });
    await stubRoutes(page, agent);
    await page.goto(`/project/${PROJECT}/agents?agent=${AGENT_ID}`);

    const enabledSwitch = page.getByRole('switch', { name: 'Enabled' });
    await expect(enabledSwitch).toBeVisible({ timeout: 8_000 });
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('clicking Enabled toggle flips its aria-checked state', async ({ page }) => {
    const agent = makeAgent({ enabled: true });
    await stubRoutes(page, agent);
    await page.goto(`/project/${PROJECT}/agents?agent=${AGENT_ID}`);

    const enabledSwitch = page.getByRole('switch', { name: 'Enabled' });
    await expect(enabledSwitch).toBeVisible({ timeout: 8_000 });
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');

    await enabledSwitch.click();
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('clicking Boostable toggle flips its aria-checked state', async ({ page }) => {
    const agent = makeAgent({ boostable: true });
    await stubRoutes(page, agent);
    await page.goto(`/project/${PROJECT}/agents?agent=${AGENT_ID}`);

    const boostableSwitch = page.getByRole('switch', { name: 'Boostable' });
    await expect(boostableSwitch).toBeVisible({ timeout: 8_000 });
    await expect(boostableSwitch).toHaveAttribute('aria-checked', 'true');

    await boostableSwitch.click();
    await expect(boostableSwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('toggling Enabled and saving sends PATCH with enabled=false', async ({ page }) => {
    const agent = makeAgent({ enabled: true });
    await stubRoutes(page, agent);

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/agents/${AGENT_ID}`, async (route: Route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = await route.request().postDataJSON();
        return route.fulfill({ json: { agent: { ...agent, enabled: false } } });
      }
      return route.continue();
    });

    await page.goto(`/project/${PROJECT}/agents?agent=${AGENT_ID}`);

    const enabledSwitch = page.getByRole('switch', { name: 'Enabled' });
    await expect(enabledSwitch).toBeVisible({ timeout: 8_000 });
    await enabledSwitch.click();
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');

    const saveBtn = page.getByRole('button', { name: /Save/ });
    await saveBtn.click();

    await expect(page.getByRole('switch', { name: 'Enabled' })).toHaveCount(0, { timeout: 6_000 });

    expect(patchBody).not.toBeNull();
    expect((patchBody as unknown as Record<string, unknown>).enabled).toBe(false);
  });

  test('schedule select shows Manual for no schedule and updates on change', async ({ page }) => {
    const agent = makeAgent({ schedule: null });
    await stubRoutes(page, agent);
    await page.goto(`/project/${PROJECT}/agents?agent=${AGENT_ID}`);

    const scheduleSelect = page.locator('#agent-schedule');
    await expect(scheduleSelect).toBeVisible({ timeout: 8_000 });
    await expect(scheduleSelect).toHaveValue('');

    await scheduleSelect.selectOption('1h');
    await expect(scheduleSelect).toHaveValue('1h');
  });
});
