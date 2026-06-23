import { test, expect } from '@playwright/test';
import type { BrowserContext, Route } from '@playwright/test';

const SUCCESS_PROJECT = 'workflow-runs-terminal-concurrent-mocked-success';
const FAILURE_PROJECT = 'workflow-runs-terminal-concurrent-mocked-failure';
const SUCCESS_RELEASE_ID = 'workflow-runs-terminal-concurrent-mocked-success-release';
const FAILURE_RELEASE_ID = 'workflow-runs-terminal-concurrent-mocked-failure-release';
const SUCCESS_RELEASE_OUTPUT = 'Mocked success release finished after the other release failed.';
const FAILURE_REASON = 'Push failed because the remote hook rejected the branch.';

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

function makeProjectConfig(project: string) {
  return {
    project,
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

function runningReleaseJob(project: string, id: string, startedAt: number) {
  return {
    id,
    project,
    kind: 'release',
    status: 'running',
    exit_code: null,
    started_at: startedAt,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    user_prompt: null,
    prompt: null,
    context_meta: null,
    provider: 'claude',
    work_summary: 'Release pipeline is still running.',
    release_id: id,
  };
}

function finishedReleaseJob(project: string, id: string) {
  return {
    ...runningReleaseJob(project, id, now() - 30),
    status: 'done',
    exit_code: 0,
    finished_at: now() - 1,
    log: `${SUCCESS_RELEASE_OUTPUT}\n`,
  };
}

function workflowRun(
  project: string,
  status: 'running' | 'completed' | 'failed',
  overrides: Partial<Record<'output' | 'error', unknown>> = {},
) {
  const terminal = status !== 'running';
  return {
    id: `workflow-run-${project}`,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status,
    createdAt: '2026-06-23T09:00:00.000Z',
    startedAt: '2026-06-23T09:00:05.000Z',
    completedAt: terminal ? '2026-06-23T09:00:20.000Z' : null,
    durationMs: terminal ? 15_000 : null,
    input: [project, { triggeredBy: `agent-${project}` }],
    output: null,
    error: null,
    ...overrides,
  };
}

async function stubSharedRoutes(
  context: BrowserContext,
  getWorkflowRuns: () => ReturnType<typeof workflowRun>[],
  getSuccessJobs: () => Array<ReturnType<typeof runningReleaseJob> | ReturnType<typeof finishedReleaseJob>>,
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
    route.fulfill({
      json: {
        tasks: [makeTask(SUCCESS_PROJECT), makeTask(FAILURE_PROJECT)],
        priorities: [],
        issueCounts: {},
      },
    }),
  );
  await context.route(
    (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
    (route: Route) =>
      route.fulfill({
        json: {
          runs: getWorkflowRuns(),
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
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) =>
      route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  );
  await context.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === SUCCESS_PROJECT,
    (route: Route) =>
      route.fulfill({
        json: {
          jobs: getSuccessJobs(),
          total: getSuccessJobs().length,
          pendingReleaseProjects: [],
        },
      }),
  );
  await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === SUCCESS_PROJECT,
    (route: Route) => {
      const jobs = getSuccessJobs();
      const running = jobs.filter((job) => job.status === 'running').length;
      const done = jobs.filter((job) => job.status === 'done').length;
      route.fulfill({
        json: {
          total: jobs.length,
          byKind: { release: jobs.length },
          byStatus: { running, done, aborted: 0, failed: 0 },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
      });
    },
  );
  await context.route(
    `**/api/projects/by-project/${SUCCESS_PROJECT}/config`,
    (route: Route) => route.fulfill({ json: makeProjectConfig(SUCCESS_PROJECT) }),
  );
  await context.route(
    `**/api/projects/by-project/${SUCCESS_PROJECT}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
  );
  await context.route(
    `**/api/agents?project=${SUCCESS_PROJECT}`,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await context.route(
    `**/api/projects/by-project/${SUCCESS_PROJECT}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await context.route(
    `**/api/projects/by-project/${SUCCESS_PROJECT}/branch`,
    (route: Route) =>
      route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
  );
  await context.route(
    (url) =>
      url.pathname === `/api/projects/by-project/${SUCCESS_PROJECT}/issues` &&
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
      url.pathname === `/api/projects/by-project/${SUCCESS_PROJECT}/issues` &&
      url.searchParams.get('summary') !== '1',
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  );
}

test.describe('Mocked workflow-runs and terminal concurrent lifecycle', () => {
  test('workflow-runs isolates a failed release while the terminal keeps the unrelated release live until success', async ({
    page,
  }) => {
    let phase: 'idle' | 'both-running' | 'failure-isolated' | 'all-done' = 'idle';
    let finishSuccessStream!: () => void;
    const successStreamDone = new Promise<void>((resolve) => {
      finishSuccessStream = resolve;
    });

    await stubSharedRoutes(
      page.context(),
      () => {
        if (phase === 'idle') return [];
        if (phase === 'both-running') {
          return [
            workflowRun(SUCCESS_PROJECT, 'running'),
            workflowRun(FAILURE_PROJECT, 'running'),
          ];
        }
        if (phase === 'failure-isolated') {
          return [
            workflowRun(SUCCESS_PROJECT, 'running'),
            workflowRun(FAILURE_PROJECT, 'failed', { error: FAILURE_REASON }),
          ];
        }
        return [
          workflowRun(SUCCESS_PROJECT, 'completed', { output: { verdict: 'LGTM' } }),
          workflowRun(FAILURE_PROJECT, 'failed', { error: FAILURE_REASON }),
        ];
      },
      () => {
        if (phase === 'all-done') return [finishedReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID)];
        if (phase === 'both-running' || phase === 'failure-isolated') {
          return [runningReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID, now() - 8)];
        }
        return [];
      },
    );

    await page.context().route(`**/api/jobs/${SUCCESS_RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json: phase === 'all-done'
          ? finishedReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID)
          : runningReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID, now() - 8),
      }),
    );
    await page.context().route(`**/api/streaming/${SUCCESS_RELEASE_ID}`, async (route: Route) => {
      await successStreamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          `data: ${SUCCESS_RELEASE_OUTPUT}`,
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            provider: 'claude',
            duration: 1600,
          })}`,
          '',
        ].join('\n'),
      });
    });

    const terminalPage = await page.context().newPage();
    await Promise.all([
      page.goto('/workflow-runs'),
      terminalPage.goto(`/project/${SUCCESS_PROJECT}/terminal`),
    ]);

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(terminalPage.getByText('live run')).toHaveCount(0);

    phase = 'both-running';

    const activePanel = page.getByLabel('Active workflow runs');
    const successActiveRow = activePanel.getByRole('link', {
      name: new RegExp(SUCCESS_PROJECT, 'i'),
    }).first();
    const failureActiveRow = activePanel.getByRole('link', {
      name: new RegExp(FAILURE_PROJECT, 'i'),
    }).first();

    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible({ timeout: 12_000 });
    await expect(successActiveRow.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(successActiveRow.locator('.animate-spin')).toBeVisible({ timeout: 12_000 });
    await expect(failureActiveRow.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(failureActiveRow.locator('.animate-spin')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 12_000 });

    await expect(terminalPage).toHaveURL(
      new RegExp(`/project/${SUCCESS_PROJECT}/terminal\\?job=${encodeURIComponent(SUCCESS_RELEASE_ID)}`),
      { timeout: 12_000 },
    );
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByTitle('View unified release trace').first()).toBeVisible({
      timeout: 12_000,
    });

    phase = 'failure-isolated';

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const failureAttentionRow = attentionPanel.getByRole('link', {
      name: new RegExp(FAILURE_PROJECT, 'i'),
    }).first();

    await expect(activePanel.getByText('1 run')).toBeVisible({ timeout: 12_000 });
    await expect(
      activePanel.getByRole('link', { name: new RegExp(FAILURE_PROJECT, 'i') }),
    ).toHaveCount(0, { timeout: 12_000 });
    await expect(successActiveRow.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(successActiveRow.locator('.animate-spin')).toBeVisible({ timeout: 12_000 });
    await expect(failureAttentionRow.getByLabel('status failed')).toBeVisible({
      timeout: 12_000,
    });
    await expect(failureAttentionRow.locator('.animate-spin')).toHaveCount(0);
    await expect(failureAttentionRow.getByText(FAILURE_REASON)).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /failed 1/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 12_000 });

    phase = 'all-done';
    finishSuccessStream();

    await expect(terminalPage.getByText(SUCCESS_RELEASE_OUTPUT)).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 12_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    });

    const successCompletedRow = page.getByRole('row').filter({ hasText: SUCCESS_PROJECT }).first();
    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(successCompletedRow.getByLabel('status completed')).toBeVisible({
      timeout: 12_000,
    });
    await expect(successCompletedRow.locator('.animate-spin')).toHaveCount(0);
    await expect(successCompletedRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    await expect(failureAttentionRow).toBeVisible();
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
  });
});
