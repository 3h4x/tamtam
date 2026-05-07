import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Job navigation UI tests — verify that clicking running job cards/rows in the
// overview and history tabs navigates to the correct terminal URL.
//
// Uses page.route() to mock all API calls; no real pipeline execution involved.

const PROJECT = 'nav-ui';

const BASE_TASK = {
  id: `${PROJECT}-1`,
  project: PROJECT,
  job: null,
  priority: null,
  launchctl: 'running',
  path: `/tmp/${PROJECT}`,
  fires_at: '',
  sync: true,
  changes: 5,
  unpushed: 0,
  reviewed: false,
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
  session_id?: string | null;
  verdict?: string;
  pid?: number;
  log_path?: string;
  seen?: boolean;
  parent_job_id?: string | null;
};

const now = () => Math.floor(Date.now() / 1000);

function makeJob(
  overrides: Partial<MockJob> &
    Pick<MockJob, 'id' | 'kind' | 'status' | 'exit_code' | 'started_at' | 'finished_at'>,
): MockJob {
  return {
    project: PROJECT,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  };
}

async function stubCommonRoutes(
  page: import('@playwright/test').Page,
  jobs: MockJob[],
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [BASE_TASK], priorities: [], issueCounts: {} },
    }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs, pendingReleaseProjects: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) =>
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
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues`, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
  );
  // Terminal tab fetches these on mount — mock them so navigation lands cleanly.
  await page.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  );
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  );
}

// ─── Test 1: Overview active work card click ──────────────────────────────────
//
// OverviewTab renders a clickable card for each running job in the "active work"
// section. Clicking the card should navigate to /project/<name>/terminal?job=<id>.

test.describe('Overview active work card navigation', () => {
  test('clicking a running job card navigates to the terminal tab with the job id', async ({
    page,
  }) => {
    const JOB_ID = 'nav-review-1';
    const jobs: MockJob[] = [
      makeJob({
        id: JOB_ID,
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 30,
        finished_at: null,
        session_id: null,
      }),
    ];

    await stubCommonRoutes(page, jobs);
    await page.goto(`/project/${PROJECT}`);

    // Wait for the "active work" section to appear.
    await expect(page.getByText('active work')).toBeVisible({ timeout: 8_000 });

    // The card is a <button> with title="Open review started ...".
    // Use getByTitle because the button's accessible name comes from its text
    // content ("Code review"), not the title attribute.
    const card = page.locator('button[title*="Open review"]').first();
    await expect(card).toBeVisible();

    await card.click();

    // Next.js App Router pushes the URL; assert the client navigated.
    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(JOB_ID)}`),
      { timeout: 8_000 },
    );
  });
});

// ─── Test 2: History tab running job row click ────────────────────────────────
//
// ProjectRunsTab renders each job as a clickable RunRow. Clicking a running
// non-run job (e.g. review, test, fix) should navigate to
// /project/<name>/terminal?job=<id>.

test.describe('History tab job row navigation', () => {
  test('clicking a running review row navigates to the terminal tab with the job id', async ({
    page,
  }) => {
    const JOB_ID = 'nav-review-2';
    const jobs: MockJob[] = [
      makeJob({
        id: JOB_ID,
        kind: 'review',
        status: 'running',
        exit_code: null,
        started_at: now() - 45,
        finished_at: null,
        session_id: null,
      }),
    ];

    await stubCommonRoutes(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);

    // Wait for the running badge so the row is definitely rendered.
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });

    // RunRow renders as a div[role="button"]. The job title for a review job is
    // "Code review" — distinct from the "review" bucket filter chip. Use the
    // job title to target the row, not the generic kind label.
    const jobRow = page
      .getByRole('button')
      .filter({ hasText: 'Code review' })
      .first();
    await expect(jobRow).toBeVisible();

    await jobRow.click();

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(JOB_ID)}`),
      { timeout: 8_000 },
    );
  });

  test('clicking a completed run-kind row with a session id navigates to terminal/<sessionId>', async ({
    page,
  }) => {
    const JOB_ID = 'nav-run-1';
    const SESSION_ID = 'sess-nav-run-1';
    const jobs: MockJob[] = [
      makeJob({
        id: JOB_ID,
        kind: 'run',
        status: 'done',
        exit_code: 0,
        started_at: now() - 120,
        finished_at: now() - 60,
        session_id: SESSION_ID,
      }),
    ];

    await stubCommonRoutes(page, jobs);
    await page.goto(`/project/${PROJECT}/history`);

    // Wait for "done" badge to confirm the row rendered.
    await expect(page.getByText('done').first()).toBeVisible({ timeout: 8_000 });

    // The run row renders "(empty prompt)" as the job title when prompt is null.
    const jobRow = page.getByRole('button').filter({ hasText: '(empty prompt)' }).first();
    await expect(jobRow).toBeVisible();

    await jobRow.click();

    // run-kind jobs with a session_id navigate to /terminal/<sessionId> (no ?job=).
    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal/${SESSION_ID}`),
      { timeout: 8_000 },
    );
  });
});
