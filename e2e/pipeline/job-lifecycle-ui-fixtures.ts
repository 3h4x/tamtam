import type { Route } from '@playwright/test';

// Job lifecycle UI tests — use the 1338 test server with mocked API responses
// to verify that the history tab and overview tab render the correct status
// badges for running, failed, cancelled, and completed jobs.

export const PROJECT = 'lifecycle-ui';

export const now = () => Math.floor(Date.now() / 1000);

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

export type MockJob = {
  id: string;
  project: string;
  kind: string;
  status: 'running' | 'done';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  verdict?: string;
  session_id?: string;
  pid?: number;
  log_path?: string;
  seen?: boolean;
  prompt?: string | null;
  user_prompt?: string | null;
  parent_job_id?: string | null;
  work_summary?: string | null;
  context_meta?: string | null;
  prompt_bytes?: number | null;
};

export async function mockJobScenario(
  page: import('@playwright/test').Page,
  jobs: MockJob[] | (() => MockJob[]),
): Promise<void> {
  const currentJobs = () => typeof jobs === 'function' ? jobs() : jobs;
  // Intercept the projects list so the page finds our project in the fleet.
  await page.route('**/api/projects', (route: Route) => {
    route.fulfill({
      json: {
        tasks: [BASE_TASK],
        priorities: [],
        issueCounts: {},
      },
    });
  });

  // Intercept all jobs requests for this project (with or without &limit= suffix).
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      route.fulfill({ json: { jobs: currentJobs(), pendingReleaseProjects: [] } });
    },
  );

  // Minimal config response so the overview tab doesn't error.
  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) => {
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
      });
    },
  );

  // Custom actions, agents, branch, behind, issues — return empty/safe values.
  await page.route(
    `**/api/projects/by-project/${PROJECT}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
  );
  await page.route(
    `**/api/agents?project=${PROJECT}`,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/branch`,
    (route: Route) =>
      route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/issues`,
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  );
  // Prevent SSE connection hangs.
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  // Notification bell
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
  );
}

export function makeJob(overrides: Partial<MockJob> & Pick<MockJob, 'id' | 'kind' | 'status' | 'exit_code' | 'started_at' | 'finished_at'>): MockJob {
  return {
    project: PROJECT,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  };
}
