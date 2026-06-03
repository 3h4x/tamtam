import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'automation-queue-ui';
const RELEASE_JOB_ID = 'automation-queue-release-1';

const now = () => Math.floor(Date.now() / 1000);

type MockJob = {
  id: string;
  project: string;
  kind: string;
  status: 'running' | 'done' | 'aborted';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  prompt?: string | null;
  user_prompt?: string | null;
  work_summary?: string | null;
  session_id?: string | null;
  release_id?: string | null;
  parent_job_id?: string | null;
  pid?: number;
  log_path?: string;
  seen?: boolean;
};

type QueueItem = {
  id: string;
  project: string;
  kind: 'pending_release' | 'queued_agent_run';
  label: string;
  reason: string;
  code: string;
  queuedAt: number | null;
  blockingJobId: string | null;
  nextRetryState: 'ready' | 'blocked' | 'waiting';
  retryAllowed: boolean;
  cancelAllowed: boolean;
  agentId?: string;
  agentName?: string;
  triggeredBy?: string;
};

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

function makeJob(overrides: Partial<MockJob> & Pick<MockJob, 'id' | 'kind' | 'status' | 'exit_code'>): MockJob {
  return {
    project: PROJECT,
    started_at: now() - 30,
    finished_at: overrides.status === 'running' ? null : now() - 5,
    prompt: null,
    user_prompt: null,
    work_summary: null,
    session_id: null,
    release_id: null,
    parent_job_id: null,
    pid: 0,
    log_path: '',
    seen: true,
    ...overrides,
  };
}

function queuedAgentItem(): QueueItem {
  return {
    id: 'queued_agent_run:42',
    project: PROJECT,
    kind: 'queued_agent_run',
    label: 'Planner agent',
    reason: 'Release pipeline is running for this project',
    code: 'pipeline_lock',
    queuedAt: (now() - 90) * 1000,
    blockingJobId: 'release-blocking-job-abcdef123456',
    nextRetryState: 'blocked',
    retryAllowed: true,
    cancelAllowed: true,
    agentId: 'agent-run-42',
    agentName: 'Planner',
  };
}

function queuedReleaseItem(): QueueItem {
  return {
    id: 'pending_release',
    project: PROJECT,
    kind: 'pending_release',
    label: 'Pending release',
    reason: 'Jobs were paused when the release was requested',
    code: 'jobs_paused',
    queuedAt: (now() - 120) * 1000,
    blockingJobId: null,
    nextRetryState: 'ready',
    retryAllowed: true,
    cancelAllowed: true,
  };
}

async function stubHistoryShellRoutes(page: Page): Promise<void> {
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
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
}

async function stubHistoryJobs(page: Page, jobsForCurrentPhase: () => MockJob[]): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const jobs = jobsForCurrentPhase();
      route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } });
    },
  );
  await page.route('**/api/jobs/counts**', (route: Route) => {
    const jobs = jobsForCurrentPhase();
    const running = jobs.filter((job) => job.status === 'running').length;
    const failed = jobs.filter((job) => job.exit_code !== null && job.exit_code !== 0).length;
    route.fulfill({
      json: {
        total: jobs.length,
        byKind: Object.fromEntries(jobs.map((job) => [job.kind, 1])),
        byStatus: {
          running,
          done: jobs.length - running,
          aborted: 0,
          failed,
        },
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        cost: { total: 0, monthToDate: 0 },
      },
    });
  });
}

test.describe('History queued automation UI', () => {
  test('queued agent Cancel posts the normalized item id and removes the queue row', async ({
    page,
  }) => {
    let cancelled = false;
    let cancelPayload: unknown = null;
    let finishCancel!: () => void;
    const cancelCanFinish = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });

    await stubHistoryShellRoutes(page);
    await stubHistoryJobs(page, () => []);
    await page.route(
      (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({ json: { items: cancelled ? [] : [queuedAgentItem()] } });
      },
    );
    await page.route('**/api/automation-queue/cancel', async (route: Route) => {
      cancelPayload = JSON.parse(route.request().postData() || '{}');
      cancelled = true;
      await cancelCanFinish;
      route.fulfill({ json: { status: 'cancelled' } });
    });

    await page.goto(`/project/${PROJECT}/history`);

    await expect(page.getByText('Queued automation')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Planner agent')).toBeVisible();
    await expect(page.getByText('pipeline_lock')).toBeVisible();
    await expect(page.getByText(/blocked by abcdef123456/)).toBeVisible();

    const cancelButton = page.getByRole('button', { name: 'Cancel' }).first();
    await expect(cancelButton).toBeEnabled();
    await cancelButton.click();

    await expect(page.getByRole('button', { name: 'cancelling' })).toBeDisabled();
    await expect.poll(() => cancelPayload).toEqual({
      kind: 'queued_agent_run',
      project: PROJECT,
      id: '42',
    });

    finishCancel();

    await expect(page.getByText('Queued automation')).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByText('Planner agent')).toHaveCount(0);
  });

  test('queued release Retry removes the queue panel and shows the running release row', async ({
    page,
  }) => {
    let retried = false;
    let retryPayload: unknown = null;

    await stubHistoryShellRoutes(page);
    await stubHistoryJobs(page, () =>
      retried
        ? [
            makeJob({
              id: RELEASE_JOB_ID,
              kind: 'release',
              status: 'running',
              exit_code: null,
              work_summary: 'Queued release is running',
            }),
          ]
        : [],
    );
    await page.route(
      (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({ json: { items: retried ? [] : [queuedReleaseItem()] } });
      },
    );
    await page.route('**/api/automation-queue/retry', (route: Route) => {
      retryPayload = JSON.parse(route.request().postData() || '{}');
      retried = true;
      route.fulfill({ json: { status: 'started', items: [] } });
    });

    await page.goto(`/project/${PROJECT}/history`);

    await expect(page.getByText('Queued automation')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Pending release')).toBeVisible();
    await expect(page.getByText('jobs_paused')).toBeVisible();

    await page.getByRole('button', { name: 'Retry' }).click();

    await expect.poll(() => retryPayload).toEqual({ project: PROJECT });
    await expect(page.getByText('Queued automation')).toHaveCount(0, { timeout: 8_000 });

    const releaseRow = page.getByRole('button').filter({ hasText: 'Release pipeline' }).first();
    await expect(releaseRow).toBeVisible({ timeout: 8_000 });
    await expect(releaseRow.getByLabel('running')).toBeVisible();
    await expect(releaseRow.getByText('running', { exact: true })).toBeVisible();
  });

  test('queued release Retry can stay queued and keep retry available while blocked', async ({
    page,
  }) => {
    let retryPayload: unknown = null;
    let queueItems = [queuedReleaseItem()];
    const blockedItem = {
      ...queuedReleaseItem(),
      reason: 'Release lock is still held by an active pipeline',
      code: 'pipeline_lock',
      blockingJobId: 'release-lock-holder-abcdef123456',
      nextRetryState: 'blocked' as const,
      retryAllowed: true,
      cancelAllowed: true,
    };

    await stubHistoryShellRoutes(page);
    await stubHistoryJobs(page, () => []);
    await page.route(
      (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({ json: { items: queueItems } });
      },
    );
    await page.route('**/api/automation-queue/retry', (route: Route) => {
      retryPayload = JSON.parse(route.request().postData() || '{}');
      queueItems = [blockedItem];
      route.fulfill({ json: { status: 'stayed_queued', items: [blockedItem] } });
    });

    await page.goto(`/project/${PROJECT}/history`);

    await expect(page.getByText('Pending release')).toBeVisible({ timeout: 8_000 });
    await page.getByRole('button', { name: 'Retry' }).click();

    await expect.poll(() => retryPayload).toEqual({ project: PROJECT });
    await expect(page.getByText('Queued automation')).toBeVisible();
    await expect(page.getByText('pipeline_lock')).toBeVisible();
    await expect(page.getByText(/blocked by abcdef123456/)).toBeVisible();
    await expect(page.getByText('Release lock is still held by an active pipeline')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeEnabled();
    await expect(page.getByRole('button').filter({ hasText: 'Release pipeline' })).toHaveCount(0);
  });

  test('queued release Retry failure keeps the row and shows a failed action state', async ({
    page,
  }) => {
    let retryPayload: unknown = null;

    await stubHistoryShellRoutes(page);
    await stubHistoryJobs(page, () => []);
    await page.route(
      (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({ json: { items: [queuedReleaseItem()] } });
      },
    );
    await page.route('**/api/automation-queue/retry', (route: Route) => {
      retryPayload = JSON.parse(route.request().postData() || '{}');
      route.fulfill({ status: 500, json: { detail: 'Recovery drain failed before starting work.' } });
    });

    await page.goto(`/project/${PROJECT}/history`);

    await expect(page.getByText('Pending release')).toBeVisible({ timeout: 8_000 });
    await page.getByRole('button', { name: 'Retry' }).click();

    await expect.poll(() => retryPayload).toEqual({ project: PROJECT });
    await expect(page.getByRole('button', { name: 'failed' })).toBeDisabled();
    await expect(page.getByText('Queued automation')).toBeVisible();
    await expect(page.getByText('Pending release')).toBeVisible();
    await expect(page.getByText('jobs_paused')).toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: 'Release pipeline' })).toHaveCount(0);
  });

  test('queued agent Cancel failure keeps the row and shows a failed action state', async ({
    page,
  }) => {
    let cancelPayload: unknown = null;

    await stubHistoryShellRoutes(page);
    await stubHistoryJobs(page, () => []);
    await page.route(
      (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({ json: { items: [queuedAgentItem()] } });
      },
    );
    await page.route('**/api/automation-queue/cancel', (route: Route) => {
      cancelPayload = JSON.parse(route.request().postData() || '{}');
      route.fulfill({ status: 500, json: { detail: 'Queue backend rejected the cancel request.' } });
    });

    await page.goto(`/project/${PROJECT}/history`);

    await expect(page.getByText('Planner agent')).toBeVisible({ timeout: 8_000 });
    await page.getByRole('button', { name: 'Cancel' }).first().click();

    await expect.poll(() => cancelPayload).toEqual({
      kind: 'queued_agent_run',
      project: PROJECT,
      id: '42',
    });
    await expect(page.getByRole('button', { name: 'failed' })).toBeDisabled();
    await expect(page.getByText('Queued automation')).toBeVisible();
    await expect(page.getByText('Planner agent')).toBeVisible();
    await expect(page.getByText('pipeline_lock')).toBeVisible();
  });
});
