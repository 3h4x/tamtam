import { test, expect } from '@playwright/test';
import type { BrowserContext, Route } from '@playwright/test';

const PROJECT = 'workflow-runs-terminal-mocked-single';
const RELEASE_ID = 'workflow-runs-terminal-mocked-single-release';
const FAILURE_DETAIL = 'Release failed after the mocked push step rejected the branch.';
const CANCELLED_DETAIL = 'Release was cancelled from the mocked workflow run.';

type Phase = 'idle' | 'running' | 'failed' | 'cancelled';
type WorkflowStatus = 'running' | 'failed' | 'completed';

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
    changes: 1,
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

function runningReleaseJob() {
  return {
    id: RELEASE_ID,
    project: PROJECT,
    kind: 'release',
    status: 'running',
    exit_code: null,
    started_at: now() - 10,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    user_prompt: null,
    prompt: null,
    context_meta: null,
    provider: 'claude',
    work_summary: 'Mocked release is still running.',
    release_id: RELEASE_ID,
  };
}

function finishedReleaseJob(exitCode: number, log: string, detail?: string) {
  return {
    ...runningReleaseJob(),
    status: 'done',
    exit_code: exitCode,
    finished_at: now() - 1,
    log,
    ...(detail ? { detail } : {}),
  };
}

function workflowRun(status: WorkflowStatus, detail?: string) {
  if (status === 'running') {
    return {
      id: `workflow-run-${PROJECT}`,
      name: 'release-orchestrator',
      rawName: 'release-orchestrator',
      status: 'running',
      createdAt: '2026-06-23T10:00:00.000Z',
      startedAt: '2026-06-23T10:00:05.000Z',
      completedAt: null,
      durationMs: null,
      input: [PROJECT, { triggeredBy: 'agent-mocked' }],
      output: null,
      error: null,
    };
  }

  if (status === 'failed') {
    return {
      id: `workflow-run-${PROJECT}`,
      name: 'release-orchestrator',
      rawName: 'release-orchestrator',
      status: 'failed',
      createdAt: '2026-06-23T10:00:00.000Z',
      startedAt: '2026-06-23T10:00:05.000Z',
      completedAt: '2026-06-23T10:00:20.000Z',
      durationMs: 15_000,
      input: [PROJECT, { triggeredBy: 'agent-mocked' }],
      output: null,
      error: detail ?? FAILURE_DETAIL,
    };
  }

  return {
    id: `workflow-run-${PROJECT}`,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status: 'completed',
    createdAt: '2026-06-23T10:00:00.000Z',
    startedAt: '2026-06-23T10:00:05.000Z',
    completedAt: '2026-06-23T10:00:20.000Z',
    durationMs: 15_000,
    input: [PROJECT, { triggeredBy: 'agent-mocked' }],
    output: { exitCode: -3, detail: detail ?? CANCELLED_DETAIL },
    error: null,
  };
}

async function stubSharedRoutes(
  context: BrowserContext,
  getPhase: () => Phase,
): Promise<void> {
  await context.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
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
  await context.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  );
  await context.route(
    (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
    (route: Route) => {
      const phase = getPhase();
      const runs =
        phase === 'idle' ? [] : [workflowRun(phase === 'running' ? 'running' : phase === 'failed' ? 'failed' : 'completed')];
      route.fulfill({
        json: {
          runs,
          meta: {
            workflowEnabled: true,
            releaseWorkflow: true,
            releaseWorkflowDrive: true,
            mode: 'drive',
          },
        },
      });
    },
  );
  await context.route(
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) =>
      route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  );
  await context.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const phase = getPhase();
      const jobs =
        phase === 'running'
          ? [runningReleaseJob()]
          : phase === 'failed'
            ? [finishedReleaseJob(2, 'Mocked release failed on both surfaces.\n', FAILURE_DETAIL)]
            : phase === 'cancelled'
              ? [finishedReleaseJob(-3, 'Mocked release was cancelled on both surfaces.\n')]
              : [];
      route.fulfill({ json: { jobs, total: jobs.length, pendingReleaseProjects: [] } });
    },
  );
  await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === PROJECT,
    (route: Route) => {
      const phase = getPhase();
      const running = phase === 'running' ? 1 : 0;
      const done = phase === 'running' || phase === 'idle' ? 0 : 1;
      const failed = phase === 'failed' ? 1 : 0;
      route.fulfill({
        json: {
          total: phase === 'idle' ? 0 : 1,
          byKind: { release: phase === 'idle' ? 0 : 1 },
          byStatus: { running, done, aborted: 0, failed },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      });
    },
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
}

test.describe('Mocked workflow-runs and terminal dual-surface lifecycle', () => {
  test('single mocked release failure clears the live spinner and shows the failure detail on both surfaces', async ({
    page,
  }) => {
    let phase: Phase = 'idle';
    let finishStream!: () => void;
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve;
    });

    await stubSharedRoutes(page.context(), () => phase);
    await page.context().route(`**/api/jobs/${RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json: phase === 'failed'
          ? finishedReleaseJob(2, 'Mocked release failed on both surfaces.\n', FAILURE_DETAIL)
          : runningReleaseJob(),
      }),
    );
    await page.context().route(`**/api/streaming/${RELEASE_ID}`, async (route: Route) => {
      await streamDone;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Mocked release failed on both surfaces.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: 2, provider: 'claude', detail: FAILURE_DETAIL, duration: 1400 })}`,
          '',
        ].join('\n'),
      });
    });

    const terminalPage = await page.context().newPage();
    await Promise.all([page.goto('/workflow-runs'), terminalPage.goto(`/project/${PROJECT}/terminal`)]);

    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('live run')).toHaveCount(0);

    phase = 'running';

    const activePanel = page.getByLabel('Active workflow runs');
    const activeRow = activePanel.getByRole('link', { name: new RegExp(PROJECT, 'i') }).first();
    await expect(activeRow.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(activeRow.locator('.animate-spin')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_ID)}`),
      { timeout: 12_000 },
    );
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 12_000 });

    const stableWorkflowRunsUrl = page.url();
    const stableTerminalUrl = terminalPage.url();
    phase = 'failed';
    finishStream();

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const failedRow = attentionPanel.getByRole('link', { name: new RegExp(PROJECT, 'i') }).first();
    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(failedRow.getByLabel('status failed')).toBeVisible({ timeout: 12_000 });
    await expect(failedRow.locator('.animate-spin')).toHaveCount(0);
    await expect(failedRow.getByText(FAILURE_DETAIL)).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /failed 1/i })).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    await expect(page).toHaveURL(stableWorkflowRunsUrl);

    await expect(terminalPage.getByText('Mocked release failed on both surfaces.')).toBeVisible({
      timeout: 12_000,
    });
    await expect(terminalPage.getByText('exit 2').first()).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByText(FAILURE_DETAIL)).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 12_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toHaveCount(0, { timeout: 12_000 });
    await expect(terminalPage.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 12_000 });
    await expect(terminalPage).toHaveURL(stableTerminalUrl);
  });

  test('single mocked release cancellation clears the live spinner and normalizes the cancelled state on both surfaces', async ({
    page,
  }) => {
    let phase: Phase = 'idle';
    let finishStream!: () => void;
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve;
    });

    await stubSharedRoutes(page.context(), () => phase);
    await page.context().route(`**/api/jobs/${RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json: phase === 'cancelled'
          ? finishedReleaseJob(-3, 'Mocked release was cancelled on both surfaces.\n')
          : runningReleaseJob(),
      }),
    );
    await page.context().route(`**/api/streaming/${RELEASE_ID}`, async (route: Route) => {
      await streamDone;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          'data: Mocked release was cancelled on both surfaces.',
          '',
          'event: done',
          `data: ${JSON.stringify({ exitCode: -3, provider: 'claude', duration: 1100 })}`,
          '',
        ].join('\n'),
      });
    });

    const terminalPage = await page.context().newPage();
    await Promise.all([page.goto('/workflow-runs'), terminalPage.goto(`/project/${PROJECT}/terminal`)]);

    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByText('live run')).toHaveCount(0);

    phase = 'running';

    const activePanel = page.getByLabel('Active workflow runs');
    const activeRow = activePanel.getByRole('link', { name: new RegExp(PROJECT, 'i') }).first();
    await expect(activeRow.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(activeRow.locator('.animate-spin')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(RELEASE_ID)}`),
      { timeout: 12_000 },
    );
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 12_000 });

    const stableWorkflowRunsUrl = page.url();
    const stableTerminalUrl = terminalPage.url();
    phase = 'cancelled';
    finishStream();

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const cancelledRow = attentionPanel.getByRole('link', { name: new RegExp(PROJECT, 'i') }).first();
    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.locator('.animate-spin')).toHaveCount(0);
    await expect(cancelledRow.getByText(CANCELLED_DETAIL)).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByText('exit -3')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /cancelled 1/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    await expect(page).toHaveURL(stableWorkflowRunsUrl);

    await expect(terminalPage.getByText('Mocked release was cancelled on both surfaces.')).toBeVisible({
      timeout: 12_000,
    });
    await expect(terminalPage.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(terminalPage.getByText('exit -3')).toHaveCount(0);
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 12_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toHaveCount(0, { timeout: 12_000 });
    await expect(terminalPage.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 12_000 });
    await expect(terminalPage).toHaveURL(stableTerminalUrl);
  });
});
