import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'overview-active-work-reflow-ui';
const now = () => Math.floor(Date.now() / 1000);

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

function makeJob(
  id: string,
  kind: string,
  status: 'running' | 'done',
  exitCode: number | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    project: PROJECT,
    kind,
    status,
    exit_code: exitCode,
    started_at: now() - 60,
    finished_at: status === 'done' ? now() - 5 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    verdict: null,
    parent_job_id: null,
    parent_kind: null,
    ...overrides,
  };
}

async function stubProjectShellRoutes(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(PROJECT)], priorities: [], issueCounts: {} },
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
        tests_disabled: false,
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
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

test.describe('Overview active-work visible reflow', () => {
  test('hidden fifth running job becomes visible when one of the four visible jobs fails', async ({
    page,
  }) => {
    let phase: 'five-running' | 'visible-failed' = 'five-running';
    const baseStarted = now() - 30;

    await stubProjectShellRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs = [
          makeJob(
            'visible-agent-live',
            'agent:research',
            phase === 'five-running' ? 'running' : 'done',
            phase === 'five-running' ? null : 1,
            {
              started_at: baseStarted + 4,
              finished_at: phase === 'five-running' ? null : now() - 1,
              provider: 'claude',
              user_prompt: 'Map active-work reflow risk',
              prompt: 'Map active-work reflow risk',
            },
          ),
          makeJob('visible-run-live', 'run', 'running', null, {
            started_at: baseStarted + 3,
            user_prompt: 'Investigate the active-work list',
            prompt: 'Investigate the active-work list',
          }),
          makeJob('visible-review-live', 'review', 'running', null, {
            started_at: baseStarted + 2,
          }),
          makeJob('visible-test-live', 'test', 'running', null, {
            started_at: baseStarted + 1,
          }),
          makeJob('hidden-push-live', 'push', 'running', null, {
            started_at: baseStarted,
          }),
        ];

        route.fulfill({ json: { jobs, pendingReleaseProjects: [] } });
      },
    );

    await page.goto(`/project/${PROJECT}`);

    const activeWork = page.locator('section').filter({ hasText: 'active work' }).first();

    await expect(page.getByText('5 running now')).toBeVisible({ timeout: 8_000 });
    await expect(activeWork.getByText('+1 more running job')).toBeVisible({ timeout: 8_000 });
    await expect(activeWork.getByRole('button', { name: /agent/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(activeWork.getByRole('button', { name: /chat/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(activeWork.getByRole('button', { name: /code review/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(activeWork.getByRole('button', { name: /test run/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(activeWork.getByRole('button', { name: /push/i })).toHaveCount(0);

    phase = 'visible-failed';

    await expect(page.getByText('4 running now')).toBeVisible({ timeout: 12_000 });
    await expect(activeWork.getByText('+1 more running job')).toHaveCount(0, { timeout: 12_000 });
    await expect(activeWork.getByRole('button', { name: /agent/i })).toHaveCount(0);
    await expect(activeWork.getByRole('button', { name: /push/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(activeWork.getByRole('button', { name: /chat/i }).first()).toBeVisible();
    await expect(activeWork.getByRole('button', { name: /code review/i }).first()).toBeVisible();
    await expect(activeWork.getByRole('button', { name: /test run/i }).first()).toBeVisible();
    await expect(page.getByLabel('active job spinner')).toHaveCount(4);
  });
});
