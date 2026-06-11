import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// History tab search empty-state UI — uses the configured baseURL with mocked
// API responses. Covers the previously-untested `search` empty-state mode
// (a non-matching query) and the "Clear filters" button reset that restores
// the full runs list. Only the `empty` and `running` empty modes had coverage;
// the search-empty + filter-reset path was a gap.

const PROJECT = 'history-search-ui';

const BASE_TASK = {
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

type MockJob = {
  id: string;
  project: string;
  kind: string;
  status: 'running' | 'done';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  prompt?: string;
  user_prompt?: string;
  session_id?: string;
  pid?: number;
  log_path?: string;
  seen?: boolean;
};

async function mockHistory(page: Page, jobs: MockJob[]): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [BASE_TASK], priorities: [], issueCounts: {} } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs, pendingReleaseProjects: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          total: jobs.length,
          byStatus: { running: 0, done: jobs.length },
          tokens: { total: 0 },
          cost: { monthToDate: 0 },
        },
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/jobs/notifications', (route: Route) => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
  );
}

function makeRun(id: string, prompt: string, startedAgo: number): MockJob {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    project: PROJECT,
    kind: 'run',
    status: 'done',
    exit_code: 0,
    started_at: now - startedAgo,
    finished_at: now - startedAgo + 20,
    prompt,
    user_prompt: prompt,
    session_id: `sess-${id}`,
    pid: 0,
    log_path: '',
    seen: true,
  };
}

test.describe('History tab search empty state + clear filters', () => {
  test('non-matching search shows the search empty state and "Clear filters" restores runs', async ({ page }) => {
    const jobs = [
      makeRun('run-alpha', 'Refactor the authentication module', 120),
      makeRun('run-beta', 'Add billing regression tests', 240),
    ];
    await mockHistory(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);

    // Both runs render once the list loads (search precedes the day groups).
    const search = page.getByPlaceholder('Search prompts, models, session ids…');
    await expect(search).toBeVisible();
    await expect(page.getByText('Refactor the authentication module')).toBeVisible();
    await expect(page.getByText('Add billing regression tests')).toBeVisible();
    await expect(page.getByText('No runs match this search')).toHaveCount(0);

    // A query that matches no prompt flips the list into the search empty state.
    await search.fill('zzz-no-such-run-xyz');
    await expect(page.getByText('No runs match this search')).toBeVisible();
    await expect(page.getByText('Nothing in all matches “zzz-no-such-run-xyz”.')).toBeVisible();
    await expect(page.getByText('Refactor the authentication module')).toHaveCount(0);
    await expect(page.getByText('Add billing regression tests')).toHaveCount(0);

    // The empty-state "Clear filters" button resets search and refilter to all.
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(page.getByText('No runs match this search')).toHaveCount(0);
    await expect(search).toHaveValue('');
    await expect(page.getByText('Refactor the authentication module')).toBeVisible();
    await expect(page.getByText('Add billing regression tests')).toBeVisible();
  });

  test('matching search narrows the list to the matching run', async ({ page }) => {
    const jobs = [
      makeRun('run-alpha', 'Refactor the authentication module', 120),
      makeRun('run-beta', 'Add billing regression tests', 240),
    ];
    await mockHistory(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);

    const search = page.getByPlaceholder('Search prompts, models, session ids…');
    await expect(page.getByText('Add billing regression tests')).toBeVisible();

    await search.fill('billing');
    await expect(page.getByText('Add billing regression tests')).toBeVisible();
    await expect(page.getByText('Refactor the authentication module')).toHaveCount(0);
    // No empty state — there is a match.
    await expect(page.getByText('No runs match this search')).toHaveCount(0);
  });
});
