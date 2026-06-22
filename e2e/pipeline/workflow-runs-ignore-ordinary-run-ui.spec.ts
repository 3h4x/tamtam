import { test, expect } from '@playwright/test';
import type { BrowserContext, Route } from '@playwright/test';

const PROJECT = 'workflow-runs-ignore-ordinary-run';
const JOB_ID = 'workflow-runs-ignore-ordinary-run-job-1';
const SESSION_ID = 'workflow-runs-ignore-ordinary-run-session-1';

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

function makeProjectConfig() {
  return {
    project: PROJECT,
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

function runningRunJob() {
  return {
    id: JOB_ID,
    project: PROJECT,
    kind: 'run',
    status: 'running',
    exit_code: null,
    started_at: now() - 30,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: SESSION_ID,
    user_prompt: 'Keep this ordinary run isolated from workflow-runs.',
    prompt: 'Keep this ordinary run isolated from workflow-runs.',
    context_meta: null,
    provider: 'claude',
    work_summary: 'The terminal run is still streaming.',
  };
}

function finishedRunJob() {
  return {
    ...runningRunJob(),
    status: 'done',
    exit_code: 2,
    finished_at: now() - 1,
    detail: 'Mock provider failed after the terminal run started',
  };
}

function finishedSuccessRunJob() {
  return {
    ...runningRunJob(),
    status: 'done',
    exit_code: 0,
    finished_at: now() - 1,
    detail: 'Mock ordinary run completed successfully after streaming output',
  };
}

function cancelledRunJob() {
  return {
    ...runningRunJob(),
    status: 'done',
    exit_code: -2,
    finished_at: now() - 1,
    detail: 'Operator cancelled the ordinary run before completion',
  };
}

async function stubSharedRoutes(
  context: BrowserContext,
  jobsForProject: () => Array<ReturnType<typeof runningRunJob> | ReturnType<typeof finishedRunJob>>,
): Promise<void> {
  await context.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await context.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  );
  await context.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await context.route('**/api/skills', (route: Route) =>
    route.fulfill({ json: { skills: [] } }),
  );
  await context.route('**/api/projects/personas', (route: Route) =>
    route.fulfill({ json: { personas: [] } }),
  );
  await context.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
  );
  await context.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await context.route(`**/api/agents?project=${PROJECT}`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await context.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await context.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  );
  await context.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') === '1',
    (route: Route) =>
      route.fulfill({
        json: {
          repo: '',
          prCount: 0,
          issueCount: 0,
          openPrBranches: [],
          error: null,
          cached: false,
          cachedAt: now(),
        },
      }),
  );
  await context.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${PROJECT}/issues` &&
      url.searchParams.get('summary') !== '1',
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  );
  await context.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  );
  await context.route(
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) =>
      route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  );
  await context.route(
    (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
    (route: Route) =>
      route.fulfill({
        json: {
          runs: [],
          meta: {
            workflowEnabled: true,
            releaseWorkflow: true,
            releaseWorkflowDrive: true,
            mode: 'drive',
          },
        },
      }),
  );
  await context.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          jobs: jobsForProject(),
          total: jobsForProject().length,
          pendingReleaseProjects: [],
        },
      }),
  );
  await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const jobs = jobsForProject();
      const running = jobs.filter((job) => job.status === 'running').length;
      const done = jobs.filter((job) => job.status === 'done').length;
      const failed = jobs.filter(
        (job) => typeof job.exit_code === 'number' && job.exit_code !== 0,
      ).length;
      route.fulfill({
        json: {
          total: jobs.length,
          byKind: { run: jobs.length },
          byStatus: { running, done, aborted: 0, failed },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      });
    },
  );
}

test.describe('Workflow-runs ignores ordinary-run lifecycle', () => {
  test('ordinary run success clears only the terminal spinner while workflow-runs stays empty', async ({
    page,
  }) => {
    let serveRunningJob = true;
    let finishStream!: () => void;
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve;
    });

    await stubSharedRoutes(page.context(), () =>
      serveRunningJob ? [runningRunJob()] : [finishedSuccessRunJob()],
    );
    await page.context().route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningRunJob()
          : {
              ...finishedSuccessRunJob(),
              log: 'Mock ordinary run completed after the workflow-runs page stayed idle.\n',
            },
      }),
    );
    await page.context().route(`**/api/streaming/${JOB_ID}`, async (route: Route) => {
      await streamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mock ordinary run completed after the workflow-runs page stayed idle.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            sessionId: SESSION_ID,
            provider: 'claude',
            detail: 'Mock ordinary run completed successfully after streaming output',
            duration: 900,
          })}`,
          '',
        ].join('\n'),
      });
    });

    const terminalPage = await page.context().newPage();

    await Promise.all([
      page.goto('/workflow-runs'),
      terminalPage.goto(`/project/${PROJECT}/terminal?job=${JOB_ID}`),
    ]);

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    await expect(
      terminalPage.getByText('Keep this ordinary run isolated from workflow-runs.'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 8_000 });

    const stableWorkflowRunsUrl = page.url();

    serveRunningJob = false;
    finishStream();

    await expect(
      terminalPage.getByText('Mock ordinary run completed after the workflow-runs page stayed idle.'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('exit 0').first()).toBeVisible({ timeout: 8_000 });
    await expect(
      terminalPage.getByText('Mock ordinary run completed successfully after streaming output'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 8_000 });

    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);
    await expect(page).toHaveURL(stableWorkflowRunsUrl);
  });

  test('ordinary run failure clears only the terminal spinner while workflow-runs stays empty', async ({
    page,
  }) => {
    let serveRunningJob = true;
    let finishStream!: () => void;
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve;
    });

    await stubSharedRoutes(page.context(), () => (serveRunningJob ? [runningRunJob()] : [finishedRunJob()]));
    await page.context().route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningRunJob()
          : {
              ...finishedRunJob(),
              log: 'Mock ordinary run failed after the workflow-runs page stayed idle.\n',
            },
      }),
    );
    await page.context().route(`**/api/streaming/${JOB_ID}`, async (route: Route) => {
      await streamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mock ordinary run failed after the workflow-runs page stayed idle.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 2,
            sessionId: SESSION_ID,
            provider: 'claude',
            detail: 'Mock provider failed after the terminal run started',
            duration: 900,
          })}`,
          '',
        ].join('\n'),
      });
    });

    const terminalPage = await page.context().newPage();

    await Promise.all([
      page.goto('/workflow-runs'),
      terminalPage.goto(`/project/${PROJECT}/terminal?job=${JOB_ID}`),
    ]);

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    await expect(
      terminalPage.getByText('Keep this ordinary run isolated from workflow-runs.'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText(/receiving output|waiting for output/)).toBeVisible();

    const stableWorkflowRunsUrl = page.url();

    serveRunningJob = false;
    finishStream();

    await expect(
      terminalPage.getByText('Mock ordinary run failed after the workflow-runs page stayed idle.'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('exit 2').first()).toBeVisible({ timeout: 8_000 });
    await expect(
      terminalPage.getByText('Mock provider failed after the terminal run started'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 8_000 });

    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);
    await expect(page).toHaveURL(stableWorkflowRunsUrl);
  });

  test('ordinary run cancellation clears only the terminal spinner while workflow-runs stays empty', async ({
    page,
  }) => {
    let serveRunningJob = true;
    let finishStream!: () => void;
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve;
    });

    await stubSharedRoutes(page.context(), () =>
      serveRunningJob ? [runningRunJob()] : [cancelledRunJob()],
    );
    await page.context().route(`**/api/jobs/${JOB_ID}`, (route: Route) =>
      route.fulfill({
        json: serveRunningJob
          ? runningRunJob()
          : {
              ...cancelledRunJob(),
              log: 'Mock ordinary run was cancelled after the workflow-runs page stayed idle.\n',
            },
      }),
    );
    await page.context().route(`**/api/streaming/${JOB_ID}`, async (route: Route) => {
      await streamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mock ordinary run was cancelled after the workflow-runs page stayed idle.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: -2,
            sessionId: SESSION_ID,
            provider: 'claude',
            detail: 'Operator cancelled the ordinary run before completion',
            duration: 900,
          })}`,
          '',
        ].join('\n'),
      });
    });

    const terminalPage = await page.context().newPage();

    await Promise.all([
      page.goto('/workflow-runs'),
      terminalPage.goto(`/project/${PROJECT}/terminal?job=${JOB_ID}`),
    ]);

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);

    await expect(
      terminalPage.getByText('Keep this ordinary run isolated from workflow-runs.'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 8_000 });

    const stableWorkflowRunsUrl = page.url();

    serveRunningJob = false;
    finishStream();

    await expect(
      terminalPage.getByText('Mock ordinary run was cancelled after the workflow-runs page stayed idle.'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('cancelled').first()).toBeVisible({ timeout: 8_000 });
    await expect(
      terminalPage.getByText('Operator cancelled the ordinary run before completion'),
    ).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('exit -2')).toHaveCount(0);
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 8_000 });

    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByLabel('Active workflow runs')).toHaveCount(0);
    await expect(page.getByLabel('Workflow runs needing attention')).toHaveCount(0);
    await expect(page).toHaveURL(stableWorkflowRunsUrl);
  });
});
