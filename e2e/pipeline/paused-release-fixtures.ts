import type { Page, Route } from '@playwright/test';

export const PROJECT = 'paused-release-ui';

export const now = () => Math.floor(Date.now() / 1000);

export function releaseButton(page: Page) {
  return page.getByRole('button', { name: 'Release', exact: true });
}

function projectIssuesPathMatcher(url: URL) {
  return url.pathname === `/api/projects/by-project/${PROJECT}/issues`;
}

export function projectIssuesMatcher(url: URL) {
  return projectIssuesPathMatcher(url) && url.searchParams.get('summary') !== '1';
}

export function projectIssuesSummaryMatcher(url: URL) {
  return projectIssuesPathMatcher(url) && url.searchParams.get('summary') === '1';
}

export function emptyIssuesSummary() {
  return {
    repo: '',
    prCount: 0,
    issueCount: 0,
    openPrBranches: [],
    error: null,
    cached: false,
    cachedAt: now(),
  };
}

export function makeTask(project: string, changes = 5, unpushed = 0) {
  return {
    id: `${project}-1`,
    project,
    job: null,
    priority: null,
    launchctl: 'running',
    path: `/tmp/${project}`,
    fires_at: '',
    sync: true,
    changes,
    unpushed,
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
}

export async function stubCommonRoutes(
  page: Page,
  settingsOverride?: Record<string, unknown>,
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(PROJECT)], priorities: [], issueCounts: {} },
    }),
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
  await page.route(projectIssuesSummaryMatcher, (route: Route) =>
    route.fulfill({ json: emptyIssuesSummary() }),
  );
  await page.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  );
  await page.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({
      json: { branch: 'master', defaultBranch: 'master', commitsAhead: null },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(projectIssuesMatcher, (route: Route) =>
    route.fulfill({ json: { prs: [], issues: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/docs`, (route: Route) =>
    route.fulfill({
      json: {
        docs: [
          {
            name: 'README.md',
            path: 'README.md',
            content: 'Project lifecycle docs fixture.\nRelease controls stay shared across tabs.',
          },
        ],
      },
    }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: settingsOverride
        ? { settings: settingsOverride, github_owner: '' }
        : { settings: { jobs_paused: 'false' }, github_owner: '' },
    }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
}
