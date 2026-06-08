import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// UI tests for the IssuesTab "Plan a GitHub issue" flow: starting the cto agent
// run and navigating to its terminal, the paused gate, the missing-cto empty
// state, the inbox-zero empty state, and inline run-failure handling. All API
// calls are mocked via page.route(); no real agent/gh execution.

const PROJECT = 'issues-tab-plan-ui';

function makeTask() {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
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

function makeCtoAgent() {
  return {
    id: 'cto-agent-1',
    name: 'cto',
    project: PROJECT,
    skillIds: ['agent-cto'],
    docPaths: [],
    model: 'sonnet',
    prompt: '',
    schedule: null,
    enabled: true,
  };
}

function makeIssuesResponse(overrides: Record<string, unknown> = {}) {
  return {
    repo: 'owner/repo',
    prs: [],
    issues: [],
    error: null,
    cached: true,
    cachedAt: 0,
    ...overrides,
  };
}

// Stub every endpoint the project detail shell + IssuesTab hit. `paused`
// controls the settings jobs_paused flag; `agents` controls /api/agents.
async function stubShell(
  page: Page,
  opts: { paused?: boolean; agents?: unknown[] } = {},
): Promise<void> {
  const { paused = false, agents = [makeCtoAgent()] } = opts;
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/settings', (route: Route) => {
    if (route.request().method() !== 'GET') { route.continue(); return; }
    route.fulfill({ json: { settings: { jobs_paused: paused ? 'true' : 'false', retrieval_enabled: 'false' } } });
  });
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues?summary=1`, (route: Route) =>
    route.fulfill({
      json: { repo: 'owner/repo', prCount: 0, issueCount: 0, openPrBranches: [], error: null, cached: true, cachedAt: 0 },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: {} }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/agents**', (route: Route) =>
    route.fulfill({ json: { agents } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

const IDEA = 'Add a per-project quota override so heavy projects get a higher token cap.';

test.describe('IssuesTab plan-a-GitHub-issue flow', () => {
  // -------------------------------------------------------------------------
  // Test 1: Planning an issue starts the cto agent and navigates to terminal
  // -------------------------------------------------------------------------
  test('planning an issue starts the cto agent and opens its terminal', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/issues?full=1`, (route: Route) =>
      route.fulfill({ json: makeIssuesResponse() }),
    );
    const runBodies: Array<{ prompt?: string; readOnly?: boolean }> = [];
    await page.route('**/api/agents/cto-agent-1/run', (route: Route) => {
      runBodies.push(route.request().postDataJSON());
      route.fulfill({ json: { status: 'started', job_id: 'plan-job-123' } });
    });

    await page.goto(`/project/${PROJECT}/issues`);

    const textarea = page.getByPlaceholder(/per-project quota override/);
    await expect(textarea).toBeVisible({ timeout: 8_000 });
    await textarea.fill(IDEA);

    const planBtn = page.getByRole('button', { name: 'Plan issue' });
    await expect(planBtn).toBeEnabled();
    await planBtn.click();

    await expect(page).toHaveURL(/\/terminal\?job=plan-job-123/, { timeout: 8_000 });
    expect(runBodies).toHaveLength(1);
    expect(runBodies[0].readOnly).toBe(true);
    expect(runBodies[0].prompt).toContain(IDEA);
  });

  // -------------------------------------------------------------------------
  // Test 2: A queued run shows a toast and stays on the issues page
  // -------------------------------------------------------------------------
  test('a queued plan run shows a toast and does not navigate', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/issues?full=1`, (route: Route) =>
      route.fulfill({ json: makeIssuesResponse() }),
    );
    await page.route('**/api/agents/cto-agent-1/run', (route: Route) =>
      route.fulfill({ json: { status: 'queued', detail: 'Agent cto queued behind a running agent' } }),
    );

    await page.goto(`/project/${PROJECT}/issues`);

    const textarea = page.getByPlaceholder(/per-project quota override/);
    await expect(textarea).toBeVisible({ timeout: 8_000 });
    await textarea.fill(IDEA);
    await page.getByRole('button', { name: 'Plan issue' }).click();

    await expect(page.getByText('Agent cto queued behind a running agent')).toBeVisible({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/issues$/);
  });

  // -------------------------------------------------------------------------
  // Test 3: A failed run surfaces an inline error toast and stays on the page
  // -------------------------------------------------------------------------
  test('a failed plan run surfaces an error toast', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/issues?full=1`, (route: Route) =>
      route.fulfill({ json: makeIssuesResponse() }),
    );
    await page.route('**/api/agents/cto-agent-1/run', (route: Route) =>
      route.fulfill({ status: 500, json: { detail: 'cto agent provider is over quota' } }),
    );

    await page.goto(`/project/${PROJECT}/issues`);

    const textarea = page.getByPlaceholder(/per-project quota override/);
    await expect(textarea).toBeVisible({ timeout: 8_000 });
    await textarea.fill(IDEA);
    await page.getByRole('button', { name: 'Plan issue' }).click();

    await expect(page.getByText('cto agent provider is over quota')).toBeVisible({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/issues$/);
  });

  // -------------------------------------------------------------------------
  // Test 4: Jobs paused disables the Plan issue button with a paused tooltip
  // -------------------------------------------------------------------------
  test('jobs paused disables the Plan issue button', async ({ page }) => {
    await stubShell(page, { paused: true });
    await page.route(`**/api/projects/by-project/${PROJECT}/issues?full=1`, (route: Route) =>
      route.fulfill({ json: makeIssuesResponse() }),
    );

    await page.goto(`/project/${PROJECT}/issues`);

    const textarea = page.getByPlaceholder(/per-project quota override/);
    await expect(textarea).toBeVisible({ timeout: 8_000 });
    await textarea.fill(IDEA);

    const planBtn = page.getByRole('button', { name: 'Plan issue' });
    await expect(planBtn).toBeDisabled();
    await expect(planBtn).toHaveAttribute('title', /Jobs are paused/);
  });

  // -------------------------------------------------------------------------
  // Test 5: Missing cto agent shows the "add the cto agent" guidance instead
  // -------------------------------------------------------------------------
  test('missing cto agent shows guidance and hides the planning textarea', async ({ page }) => {
    await stubShell(page, { agents: [] });
    await page.route(`**/api/projects/by-project/${PROJECT}/issues?full=1`, (route: Route) =>
      route.fulfill({ json: makeIssuesResponse() }),
    );

    await page.goto(`/project/${PROJECT}/issues`);

    await expect(page.getByText('Plan a GitHub issue')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('link', { name: 'cto agent' })).toBeVisible();
    await expect(page.getByPlaceholder(/per-project quota override/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Plan issue' })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Test 6: No open PRs or issues renders the inbox-zero empty state
  // -------------------------------------------------------------------------
  test('an empty inbox renders the inbox-zero empty state', async ({ page }) => {
    await stubShell(page);
    await page.route(`**/api/projects/by-project/${PROJECT}/issues?full=1`, (route: Route) =>
      route.fulfill({ json: makeIssuesResponse({ prs: [], issues: [] }) }),
    );

    await page.goto(`/project/${PROJECT}/issues`);

    await expect(page.getByText('Inbox zero')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('GitHub shows no open PRs or issues for this project.')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Test 7: A transient issues load failure recovers through ErrorState retry
  // -------------------------------------------------------------------------
  test('a failed issues load shows Retry and recovers without reload', async ({ page }) => {
    await stubShell(page);

    let issuesLoadCount = 0;
    await page.route(`**/api/projects/by-project/${PROJECT}/issues?full=1`, (route: Route) => {
      issuesLoadCount += 1;
      if (issuesLoadCount === 1) {
        route.fulfill({ status: 500, json: { detail: 'gh api temporary failure' } });
        return;
      }
      route.fulfill({
        json: makeIssuesResponse({
          issues: [{
            number: 42,
            title: 'Recovered issue after retry',
            url: 'https://github.com/example/repo/issues/42',
            state: 'OPEN',
            labels: [{ name: 'bug', color: 'd73a4a' }],
            author: { login: 'octocat' },
            createdAt: '2026-06-08T00:00:00Z',
            updatedAt: '2026-06-08T00:00:00Z',
            assignees: [],
            body: '',
          }],
        }),
      });
    });

    await page.goto(`/project/${PROJECT}/issues`);

    await expect(page.getByText(/failed to fetch issues/i)).toBeVisible({ timeout: 8_000 });
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();

    await retry.click();

    await expect(page.getByText('Recovered issue after retry')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/failed to fetch issues/i)).not.toBeVisible();
    expect(issuesLoadCount).toBeGreaterThanOrEqual(2);
  });
});
