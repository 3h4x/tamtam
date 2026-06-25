import { test, expect } from '@playwright/test';
import type { BrowserContext, Route } from '@playwright/test';

const FIRST_PROJECT = 'workflow-runs-terminal-concurrent-success-mocked-first';
const SECOND_PROJECT = 'workflow-runs-terminal-concurrent-success-mocked-second';
const FIRST_RELEASE_ID = 'workflow-runs-terminal-concurrent-success-mocked-first-release';
const SECOND_RELEASE_ID = 'workflow-runs-terminal-concurrent-success-mocked-second-release';
const FIRST_RELEASE_OUTPUT = 'First mocked release finished while the second release kept running.';
const SECOND_RELEASE_SUMMARY = 'Second mocked release finished after the first one already settled.';

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

function runningReleaseJob(project: string, id: string, startedAt: number, summary: string) {
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
    work_summary: summary,
    release_id: id,
  };
}

function finishedReleaseJob(project: string, id: string, log: string) {
  return {
    ...runningReleaseJob(project, id, now() - 30, log.trim()),
    status: 'done',
    exit_code: 0,
    finished_at: now() - 1,
    log,
  };
}

function workflowRun(
  project: string,
  status: 'running' | 'completed',
  output: Record<string, unknown> | null = null,
) {
  const terminal = status !== 'running';
  return {
    id: `workflow-run-${project}`,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status,
    createdAt: '2026-06-25T11:00:00.000Z',
    startedAt: '2026-06-25T11:00:05.000Z',
    completedAt: terminal ? '2026-06-25T11:00:20.000Z' : null,
    durationMs: terminal ? 15_000 : null,
    input: [project, { triggeredBy: `agent-${project}` }],
    output,
    error: null,
  };
}

async function stubSharedRoutes(
  context: BrowserContext,
  getWorkflowRuns: () => ReturnType<typeof workflowRun>[],
  getFirstJobs: () => Array<ReturnType<typeof runningReleaseJob> | ReturnType<typeof finishedReleaseJob>>,
  getSecondJobs: () => Array<ReturnType<typeof runningReleaseJob> | ReturnType<typeof finishedReleaseJob>> = () => [],
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
        tasks: [makeTask(FIRST_PROJECT), makeTask(SECOND_PROJECT)],
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

  await stubProjectRoutes(FIRST_PROJECT, getFirstJobs);
  await stubProjectRoutes(SECOND_PROJECT, getSecondJobs);
}

test.describe('Mocked workflow-runs and terminal concurrent success lifecycle', () => {
  test('one release can finish successfully while the unrelated release keeps its running spinner until it settles', async ({
    page,
  }) => {
    let phase: 'idle' | 'both-running' | 'first-done' | 'all-done' = 'idle';
    let finishFirstStream!: () => void;
    const firstStreamDone = new Promise<void>((resolve) => {
      finishFirstStream = resolve;
    });

    await stubSharedRoutes(
      page.context(),
      () => {
        if (phase === 'idle') return [];
        if (phase === 'both-running') {
          return [
            workflowRun(FIRST_PROJECT, 'running'),
            workflowRun(SECOND_PROJECT, 'running'),
          ];
        }
        if (phase === 'first-done') {
          return [
            workflowRun(FIRST_PROJECT, 'completed', { verdict: 'LGTM' }),
            workflowRun(SECOND_PROJECT, 'running'),
          ];
        }
        return [
          workflowRun(FIRST_PROJECT, 'completed', { verdict: 'LGTM' }),
          workflowRun(SECOND_PROJECT, 'completed', {
            verdict: 'LGTM',
            summary: SECOND_RELEASE_SUMMARY,
          }),
        ];
      },
      () => {
        if (phase === 'both-running') {
          return [
            runningReleaseJob(FIRST_PROJECT, FIRST_RELEASE_ID, now() - 10, 'First release still running.'),
          ];
        }
        if (phase === 'first-done' || phase === 'all-done') {
          return [finishedReleaseJob(FIRST_PROJECT, FIRST_RELEASE_ID, `${FIRST_RELEASE_OUTPUT}\n`)];
        }
        return [];
      },
    );

    await page.context().route(`**/api/jobs/${FIRST_RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'both-running'
            ? runningReleaseJob(FIRST_PROJECT, FIRST_RELEASE_ID, now() - 10, 'First release still running.')
            : finishedReleaseJob(FIRST_PROJECT, FIRST_RELEASE_ID, `${FIRST_RELEASE_OUTPUT}\n`),
      }),
    );
    await page.context().route(`**/api/streaming/${FIRST_RELEASE_ID}`, async (route: Route) => {
      await firstStreamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          `data: ${FIRST_RELEASE_OUTPUT}`,
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            provider: 'claude',
            duration: 1200,
          })}`,
          '',
        ].join('\n'),
      });
    });

    const terminalPage = await page.context().newPage();
    await Promise.all([
      page.goto('/workflow-runs'),
      terminalPage.goto(`/project/${FIRST_PROJECT}/terminal`),
    ]);

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });

    phase = 'both-running';

    const activePanel = page.getByLabel('Active workflow runs');
    const firstActiveRow = activePanel.getByRole('link', {
      name: new RegExp(FIRST_PROJECT, 'i'),
    }).first();
    const secondActiveRow = activePanel.getByRole('link', {
      name: new RegExp(SECOND_PROJECT, 'i'),
    }).first();

    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible({ timeout: 12_000 });
    await expect(firstActiveRow.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(firstActiveRow.locator('.animate-spin')).toBeVisible({ timeout: 12_000 });
    await expect(secondActiveRow.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(secondActiveRow.locator('.animate-spin')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 12_000 });

    phase = 'first-done';
    finishFirstStream();

    const completedFirstRow = page.getByRole('row').filter({ hasText: FIRST_PROJECT }).first();
    await expect(terminalPage.getByText(FIRST_RELEASE_OUTPUT)).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 12_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(activePanel.getByText('1 run')).toBeVisible({ timeout: 12_000 });
    await expect(
      activePanel.getByRole('link', { name: new RegExp(FIRST_PROJECT, 'i') }),
    ).toHaveCount(0, { timeout: 12_000 });
    await expect(secondActiveRow.getByLabel('status running')).toBeVisible({ timeout: 12_000 });
    await expect(secondActiveRow.locator('.animate-spin')).toBeVisible({ timeout: 12_000 });
    await expect(completedFirstRow.getByLabel('status completed')).toBeVisible({
      timeout: 12_000,
    });
    await expect(completedFirstRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });

    phase = 'all-done';

    const completedSecondRow = page.getByRole('row').filter({ hasText: SECOND_PROJECT }).first();
    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(completedSecondRow.getByLabel('status completed')).toBeVisible({
      timeout: 12_000,
    });
    await expect(completedSecondRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
  });

  test('separate terminal pages keep concurrent releases isolated until each one settles', async ({
    page,
  }) => {
    let phase: 'idle' | 'both-running' | 'first-done' | 'all-done' = 'idle';
    let finishFirstStream!: () => void;
    let finishSecondStream!: () => void;
    const firstStreamDone = new Promise<void>((resolve) => {
      finishFirstStream = resolve;
    });
    const secondStreamDone = new Promise<void>((resolve) => {
      finishSecondStream = resolve;
    });

    await stubSharedRoutes(
      page.context(),
      () => {
        if (phase === 'idle') return [];
        if (phase === 'both-running') {
          return [
            workflowRun(FIRST_PROJECT, 'running'),
            workflowRun(SECOND_PROJECT, 'running'),
          ];
        }
        if (phase === 'first-done') {
          return [
            workflowRun(FIRST_PROJECT, 'completed', { verdict: 'LGTM' }),
            workflowRun(SECOND_PROJECT, 'running'),
          ];
        }
        return [
          workflowRun(FIRST_PROJECT, 'completed', { verdict: 'LGTM' }),
          workflowRun(SECOND_PROJECT, 'completed', {
            verdict: 'LGTM',
            summary: SECOND_RELEASE_SUMMARY,
          }),
        ];
      },
      () => {
        if (phase === 'both-running') {
          return [
            runningReleaseJob(FIRST_PROJECT, FIRST_RELEASE_ID, now() - 10, 'First release still running.'),
          ];
        }
        if (phase === 'first-done' || phase === 'all-done') {
          return [finishedReleaseJob(FIRST_PROJECT, FIRST_RELEASE_ID, `${FIRST_RELEASE_OUTPUT}\n`)];
        }
        return [];
      },
      () => {
        if (phase === 'both-running' || phase === 'first-done') {
          return [
            runningReleaseJob(SECOND_PROJECT, SECOND_RELEASE_ID, now() - 12, 'Second release still running.'),
          ];
        }
        if (phase === 'all-done') {
          return [finishedReleaseJob(SECOND_PROJECT, SECOND_RELEASE_ID, `${SECOND_RELEASE_SUMMARY}\n`)];
        }
        return [];
      },
    );

    await page.context().route(`**/api/jobs/${FIRST_RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'both-running'
            ? runningReleaseJob(FIRST_PROJECT, FIRST_RELEASE_ID, now() - 10, 'First release still running.')
            : finishedReleaseJob(FIRST_PROJECT, FIRST_RELEASE_ID, `${FIRST_RELEASE_OUTPUT}\n`),
      }),
    );
    await page.context().route(`**/api/jobs/${SECOND_RELEASE_ID}`, (route: Route) =>
      route.fulfill({
        json:
          phase === 'all-done'
            ? finishedReleaseJob(SECOND_PROJECT, SECOND_RELEASE_ID, `${SECOND_RELEASE_SUMMARY}\n`)
            : runningReleaseJob(SECOND_PROJECT, SECOND_RELEASE_ID, now() - 12, 'Second release still running.'),
      }),
    );
    await page.context().route(`**/api/streaming/${FIRST_RELEASE_ID}`, async (route: Route) => {
      await firstStreamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          `data: ${FIRST_RELEASE_OUTPUT}`,
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            provider: 'claude',
            duration: 1200,
          })}`,
          '',
        ].join('\n'),
      });
    });
    await page.context().route(`**/api/streaming/${SECOND_RELEASE_ID}`, async (route: Route) => {
      await secondStreamDone;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: [
          `data: ${SECOND_RELEASE_SUMMARY}`,
          '',
          'event: done',
          `data: ${JSON.stringify({
            exitCode: 0,
            provider: 'claude',
            duration: 1500,
          })}`,
          '',
        ].join('\n'),
      });
    });

    const firstTerminalPage = await page.context().newPage();
    const secondTerminalPage = await page.context().newPage();
    await Promise.all([
      page.goto('/workflow-runs'),
      firstTerminalPage.goto(`/project/${FIRST_PROJECT}/terminal`),
      secondTerminalPage.goto(`/project/${SECOND_PROJECT}/terminal`),
    ]);

    phase = 'both-running';

    await expect(page.getByText('2 running')).toBeVisible({ timeout: 12_000 });
    await expect(firstTerminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 12_000 });
    await expect(secondTerminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 12_000 });

    phase = 'first-done';
    finishFirstStream();

    await expect(firstTerminalPage.getByText(FIRST_RELEASE_OUTPUT)).toBeVisible({ timeout: 12_000 });
    await expect(firstTerminalPage.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 12_000 });
    await expect(firstTerminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(secondTerminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 12_000 });
    await expect(secondTerminalPage.getByText('live run')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /completed 1/i })).toBeVisible({
      timeout: 12_000,
    });

    phase = 'all-done';
    finishSecondStream();

    await expect(secondTerminalPage.getByText(SECOND_RELEASE_SUMMARY)).toBeVisible({
      timeout: 12_000,
    });
    await expect(secondTerminalPage.getByText('exit 0 — ok').first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(secondTerminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('button', { name: /completed 2/i })).toBeVisible({
      timeout: 12_000,
    });
  });
});
