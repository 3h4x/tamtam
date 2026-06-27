import { test, expect } from '@playwright/test';
import type { BrowserContext, Route } from '@playwright/test';

const SUCCESS_PROJECT = 'workflow-runs-terminal-concurrent-mocked-success';
const FAILURE_PROJECT = 'workflow-runs-terminal-concurrent-mocked-failure';
const SUCCESS_RELEASE_ID = 'workflow-runs-terminal-concurrent-mocked-success-release';
const FAILURE_RELEASE_ID = 'workflow-runs-terminal-concurrent-mocked-failure-release';
const SUCCESS_RELEASE_OUTPUT = 'Mocked success release finished after the other release failed.';
const FAILURE_REASON = 'Push failed because the remote hook rejected the branch.';
const CANCELLED_DETAIL = 'Release was cancelled before the mocked push step completed.';

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

function finishedCancelledReleaseJob(project: string, id: string) {
  return {
    ...runningReleaseJob(project, id, now() - 30),
    status: 'done',
    exit_code: -3,
    finished_at: now() - 1,
    log: 'Mocked cancelled release stopped before the final push step.\n',
    detail: CANCELLED_DETAIL,
  };
}

function workflowRun(
  project: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled',
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
  getFailureJobs: () => Array<ReturnType<typeof runningReleaseJob> | ReturnType<typeof finishedReleaseJob>> = () => [],
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
  const stubProjectRoutes = async (
    project: string,
    getJobs: () => Array<ReturnType<typeof runningReleaseJob> | ReturnType<typeof finishedReleaseJob>>,
  ) => {
    await context.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === project,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: getJobs(),
            total: getJobs().length,
            pendingReleaseProjects: [],
          },
        }),
    );
    await context.route(
    (url) => url.pathname === '/api/jobs/counts' && url.searchParams.get('project') === project,
    (route: Route) => {
      const jobs = getJobs();
      const running = jobs.filter((job) => job.status === 'running').length;
      const done = jobs.filter((job) => job.status === 'done').length;
      const aborted = jobs.filter((job) => job.exit_code === -3).length;
      const failed = jobs.filter(
        (job) => typeof job.exit_code === 'number' && job.exit_code !== 0 && job.exit_code !== -3,
      ).length;
      route.fulfill({
        json: {
          total: jobs.length,
          byKind: { release: jobs.length },
          byStatus: { running, done, aborted, failed },
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
          cost: { total: 0, monthToDate: 0 },
        },
        });
      },
    );
    await context.route(
      `**/api/projects/by-project/${project}/config`,
      (route: Route) => route.fulfill({ json: makeProjectConfig(project) }),
    );
    await context.route(
      `**/api/projects/by-project/${project}/action`,
      (route: Route) => route.fulfill({ json: { actions: [] } }),
    );
    await context.route(
      `**/api/agents?project=${project}`,
      (route: Route) => route.fulfill({ json: { agents: [] } }),
    );
    await context.route(
      `**/api/projects/by-project/${project}/behind`,
      (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
    );
    await context.route(
      `**/api/projects/by-project/${project}/branch`,
      (route: Route) =>
        route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: null } }),
    );
    await context.route(
      (url) =>
        url.pathname === `/api/projects/by-project/${project}/issues` &&
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
        url.pathname === `/api/projects/by-project/${project}/issues` &&
        url.searchParams.get('summary') !== '1',
      (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
    );
  };

  await stubProjectRoutes(SUCCESS_PROJECT, getSuccessJobs);
  await stubProjectRoutes(FAILURE_PROJECT, getFailureJobs);
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

  test('one terminal can settle to failure while the unrelated terminal keeps its live spinner until success', async ({
    page,
  }) => {
    let phase: 'idle' | 'both-running' | 'failure-isolated' | 'all-done' = 'idle';
    let finishSuccessStream!: () => void;
    let finishFailureStream!: () => void;
    const successStreamDone = new Promise<void>((resolve) => {
      finishSuccessStream = resolve;
    });
    const failureStreamDone = new Promise<void>((resolve) => {
      finishFailureStream = resolve;
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
        if (phase === 'both-running' || phase === 'failure-isolated') {
          return [runningReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID, now() - 8)];
        }
        if (phase === 'all-done') {
          return [finishedReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID)];
        }
        return [];
      },
      () => (
        phase === 'both-running'
          ? [runningReleaseJob(FAILURE_PROJECT, FAILURE_RELEASE_ID, now() - 9)]
          : []
      ),
    );

    await page.context().route(`**/api/jobs/${SUCCESS_RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'all-done'
            ? finishedReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID)
            : runningReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID, now() - 8),
      }),
    );
    await page.context().route(`**/api/jobs/${FAILURE_RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'both-running'
            ? runningReleaseJob(FAILURE_PROJECT, FAILURE_RELEASE_ID, now() - 9)
            : {
                ...runningReleaseJob(FAILURE_PROJECT, FAILURE_RELEASE_ID, now() - 9),
                status: 'done',
                exit_code: 2,
                finished_at: now() - 1,
                log: 'Mocked failure release stopped after the push hook rejected the branch.\n',
                detail: FAILURE_REASON,
              },
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
    await page.context().route(`**/api/streaming/${FAILURE_RELEASE_ID}`, async (route: Route) => {
      await failureStreamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mocked failure release stopped after the push hook rejected the branch.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 2,
            provider: 'claude',
            detail: FAILURE_REASON,
            duration: 1400,
          })}`,
          '',
        ].join('\n'),
      });
    });

    const successTerminalPage = await page.context().newPage();
    const failureTerminalPage = await page.context().newPage();
    await Promise.all([
      successTerminalPage.goto(`/project/${SUCCESS_PROJECT}/terminal`),
      failureTerminalPage.goto(`/project/${FAILURE_PROJECT}/terminal`),
    ]);

    await expect(successTerminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(failureTerminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(successTerminalPage.getByText('live run')).toHaveCount(0);
    await expect(failureTerminalPage.getByText('live run')).toHaveCount(0);

    phase = 'both-running';

    await expect(successTerminalPage).toHaveURL(
      new RegExp(`/project/${SUCCESS_PROJECT}/terminal\\?job=${encodeURIComponent(SUCCESS_RELEASE_ID)}`),
      { timeout: 12_000 },
    );
    await expect(failureTerminalPage).toHaveURL(
      new RegExp(`/project/${FAILURE_PROJECT}/terminal\\?job=${encodeURIComponent(FAILURE_RELEASE_ID)}`),
      { timeout: 12_000 },
    );
    await expect(successTerminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(failureTerminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(successTerminalPage.getByLabel('live run spinner')).toBeVisible({
      timeout: 12_000,
    });
    await expect(failureTerminalPage.getByLabel('live run spinner')).toBeVisible({
      timeout: 12_000,
    });

    phase = 'failure-isolated';
    finishFailureStream();

    await expect(failureTerminalPage.getByText(FAILURE_REASON)).toBeVisible({ timeout: 12_000 });
    await expect(failureTerminalPage.getByText('exit 2').first()).toBeVisible({ timeout: 12_000 });
    await expect(failureTerminalPage.getByText('live run')).toHaveCount(0, { timeout: 12_000 });
    await expect(failureTerminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(successTerminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(successTerminalPage.getByLabel('live run spinner')).toBeVisible({
      timeout: 12_000,
    });

    phase = 'all-done';
    finishSuccessStream();

    await expect(successTerminalPage.getByText(SUCCESS_RELEASE_OUTPUT)).toBeVisible({
      timeout: 12_000,
    });
    await expect(successTerminalPage.getByText('exit 0 — ok').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(successTerminalPage.getByText('live run')).toHaveCount(0, { timeout: 12_000 });
    await expect(successTerminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    });
  });

  test('two live releases can diverge to cancelled and failed on the same poll without leaving stale spinners on either surface', async ({
    page,
  }) => {
    let phase: 'idle' | 'both-running' | 'both-attention' = 'idle';
    let finishCancelledStream!: () => void;
    let finishFailureStream!: () => void;
    const cancelledStreamDone = new Promise<void>((resolve) => {
      finishCancelledStream = resolve;
    });
    const failureStreamDone = new Promise<void>((resolve) => {
      finishFailureStream = resolve;
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
        return [
          workflowRun(SUCCESS_PROJECT, 'cancelled', { error: CANCELLED_DETAIL }),
          workflowRun(FAILURE_PROJECT, 'failed', { error: FAILURE_REASON }),
        ];
      },
      () => (
        phase === 'both-running'
          ? [runningReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID, now() - 8)]
          : [finishedCancelledReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID)]
      ),
      () => (
        phase === 'both-running'
          ? [runningReleaseJob(FAILURE_PROJECT, FAILURE_RELEASE_ID, now() - 9)]
          : [{
              ...runningReleaseJob(FAILURE_PROJECT, FAILURE_RELEASE_ID, now() - 9),
              status: 'done',
              exit_code: 2,
              finished_at: now() - 1,
              log: 'Mocked failure release stopped after the push hook rejected the branch.\n',
              detail: FAILURE_REASON,
            }]
      ),
    );

    await page.context().route(`**/api/jobs/${SUCCESS_RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'both-running'
            ? runningReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID, now() - 8)
            : finishedCancelledReleaseJob(SUCCESS_PROJECT, SUCCESS_RELEASE_ID),
      }),
    );
    await page.context().route(`**/api/jobs/${FAILURE_RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'both-running'
            ? runningReleaseJob(FAILURE_PROJECT, FAILURE_RELEASE_ID, now() - 9)
            : {
                ...runningReleaseJob(FAILURE_PROJECT, FAILURE_RELEASE_ID, now() - 9),
                status: 'done',
                exit_code: 2,
                finished_at: now() - 1,
                log: 'Mocked failure release stopped after the push hook rejected the branch.\n',
                detail: FAILURE_REASON,
              },
      }),
    );
    await page.context().route(`**/api/streaming/${SUCCESS_RELEASE_ID}`, async (route: Route) => {
      await cancelledStreamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mocked cancelled release stopped before the final push step.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: -3,
            provider: 'claude',
            detail: CANCELLED_DETAIL,
            duration: 1400,
          })}`,
          '',
        ].join('\n'),
      });
    });
    await page.context().route(`**/api/streaming/${FAILURE_RELEASE_ID}`, async (route: Route) => {
      await failureStreamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          'data: Mocked failure release stopped after the push hook rejected the branch.',
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 2,
            provider: 'claude',
            detail: FAILURE_REASON,
            duration: 1400,
          })}`,
          '',
        ].join('\n'),
      });
    });

    const cancelledTerminalPage = await page.context().newPage();
    const failureTerminalPage = await page.context().newPage();
    await Promise.all([
      page.goto('/workflow-runs'),
      cancelledTerminalPage.goto(`/project/${SUCCESS_PROJECT}/terminal`),
      failureTerminalPage.goto(`/project/${FAILURE_PROJECT}/terminal`),
    ]);

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(cancelledTerminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(failureTerminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });

    phase = 'both-running';

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 12_000 });
    await expect(cancelledTerminalPage).toHaveURL(
      new RegExp(`/project/${SUCCESS_PROJECT}/terminal\\?job=${encodeURIComponent(SUCCESS_RELEASE_ID)}`),
      { timeout: 12_000 },
    );
    await expect(failureTerminalPage).toHaveURL(
      new RegExp(`/project/${FAILURE_PROJECT}/terminal\\?job=${encodeURIComponent(FAILURE_RELEASE_ID)}`),
      { timeout: 12_000 },
    );
    await expect(cancelledTerminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(failureTerminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(cancelledTerminalPage.getByLabel('live run spinner')).toBeVisible({
      timeout: 12_000,
    });
    await expect(failureTerminalPage.getByLabel('live run spinner')).toBeVisible({
      timeout: 12_000,
    });

    phase = 'both-attention';
    finishCancelledStream();
    finishFailureStream();

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const cancelledAttentionRow = attentionPanel
      .getByRole('link', { name: new RegExp(SUCCESS_PROJECT, 'i') })
      .first();
    const failureAttentionRow = attentionPanel
      .getByRole('link', { name: new RegExp(FAILURE_PROJECT, 'i') })
      .first();

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(cancelledAttentionRow.getByLabel('status cancelled')).toBeVisible({
      timeout: 12_000,
    });
    await expect(failureAttentionRow.getByLabel('status failed')).toBeVisible({
      timeout: 12_000,
    });
    await expect(cancelledAttentionRow.locator('.animate-spin')).toHaveCount(0);
    await expect(failureAttentionRow.locator('.animate-spin')).toHaveCount(0);
    await expect(cancelledAttentionRow.getByText(CANCELLED_DETAIL)).toBeVisible({
      timeout: 12_000,
    });
    await expect(failureAttentionRow.getByText(FAILURE_REASON)).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^cancelled 1$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /^failed 1$/i })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('2 running')).toHaveCount(0, { timeout: 12_000 });

    await expect(cancelledTerminalPage.getByText('Mocked cancelled release stopped before the final push step.')).toBeVisible({
      timeout: 12_000,
    });
    await expect(cancelledTerminalPage.getByText('cancelled', { exact: true }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(cancelledTerminalPage.getByText('exit -3')).toHaveCount(0);
    await expect(cancelledTerminalPage.getByText('live run')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(cancelledTerminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    });

    await expect(failureTerminalPage.getByText(FAILURE_REASON)).toBeVisible({ timeout: 12_000 });
    await expect(failureTerminalPage.getByText('exit 2').first()).toBeVisible({ timeout: 12_000 });
    await expect(failureTerminalPage.getByText('live run')).toHaveCount(0, { timeout: 12_000 });
    await expect(failureTerminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    });
  });
});
