import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Live-update UI tests — verify auto-polling state transitions and concurrent
// multi-project job visibility without page reload.
//
// Uses page.route() to intercept API calls; no real pipeline execution is
// involved (no Claude shim, no git shim, no PM2 jobs).

const PROJECT = 'lifecycle-ui'; // reuse the mocked-API project from job-lifecycle-ui.spec.ts

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
  project: string,
  status: 'running' | 'done',
  exit_code: number | null,
  kind = 'review',
  timing?: { startedAt?: number; finishedAt?: number | null },
) {
  const startedAt = timing?.startedAt ?? now() - 60;
  const finishedAt = timing?.finishedAt ?? (status === 'done' ? now() - 5 : null);
  return {
    id,
    project,
    kind,
    status,
    exit_code,
    started_at: startedAt,
    finished_at: finishedAt,
    pid: 0,
    log_path: '',
    seen: true,
  };
}

function runRow(page: import('@playwright/test').Page, project: string) {
  return page.getByRole('button').filter({ hasText: project }).first();
}

function runningRunRows(page: import('@playwright/test').Page) {
  return page.getByRole('button').filter({ has: page.locator('[aria-label="running"]') });
}

function historyRowByTitle(page: import('@playwright/test').Page, title: string) {
  return page.getByRole('button').filter({ hasText: title }).first();
}

function statusFilterButton(
  page: import('@playwright/test').Page,
  label: 'running' | 'done' | 'failed',
) {
  return page.getByRole('button', { name: new RegExp(`^${label} \\d+$`) }).first();
}

function captureReactKeyWarnings(page: import('@playwright/test').Page) {
  const warnings: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Each child in a list should have a unique "key" prop/.test(text)) {
      warnings.push(text);
    }
  });
  return warnings;
}

async function stubCommonRoutes(
  page: import('@playwright/test').Page,
  project: string,
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(project)], priorities: [], issueCounts: {} },
    }),
  );
  await page.route(
    `**/api/projects/by-project/${project}/config`,
    (route: Route) =>
      route.fulfill({
        json: {
          project,
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
  await page.route(
    `**/api/projects/by-project/${project}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
  );
  await page.route(
    `**/api/agents?project=${project}`,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${project}/branch`,
    (route: Route) =>
      route.fulfill({
        json: { branch: 'master', defaultBranch: 'master', commitsAhead: null },
      }),
  );
  await page.route(
    `**/api/projects/by-project/${project}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    `**/api/projects/by-project/${project}/issues`,
    (route: Route) => route.fulfill({ json: { prs: [], issues: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/automation-queue' && url.searchParams.get('project') === project,
    (route: Route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { jobs_paused: false, github_owner: '' } }),
  );
}

// ─── Test 1: Auto-polling live update ────────────────────────────────────────
//
// ProjectRunsTab (history tab) polls /api/jobs every 5 s.
// This test verifies the UI transitions from "running" to "done" on the
// next poll cycle — no page.reload() allowed.

test.describe('Auto-polling live update', () => {
  test('history tab transitions running→done via 5s poll cycle without page reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubCommonRoutes(page, PROJECT);

    // Dynamic mock: first calls return "running", subsequent calls return "done".
    // The closure variable is flipped after the page renders the initial state.
    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              // Use kind:'test' — review jobs with no verdict render "review verdict missing"
              // instead of "done", which would break the Phase 2 assertion.
              makeJob(
                'auto-poll-job',
                PROJECT,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : 0,
                'test',
              ),
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);
    const row = page.getByRole('button').filter({ hasText: 'Test run' }).first();

    // Phase 1: the initial fetch returns "running" — verify the badge is visible.
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    // Flip the mock so the next poll (≤5 s away) will return "done".
    serveRunning = false;

    // Phase 2: wait for the auto-poll to fire and the UI to update.
    // Allow 12 s: one full 5 s poll cycle + rendering time + safety buffer.
    // No page.reload() — the polling loop must pick up the change.
    await expect(row.locator('[aria-label="done"]')).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history running filter clears when its only running job completes without reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'running-filter-clears-job',
                PROJECT,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : 0,
                'test',
              ),
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button')
      .filter({ hasText: 'test' })
      .filter({ has: page.locator('[aria-label="running"]') })
      .first();

    await expect(row).toBeVisible({ timeout: 8_000 });
    await statusFilterButton(page, 'running').click();
    await expect(row).toBeVisible();
    await expect(page.getByText('Nothing is running right now')).toHaveCount(0);

    serveRunning = false;

    await expect(page.getByText('Nothing is running right now')).toBeVisible({
      timeout: 12_000,
    });
    await expect(
      page.getByText('This project has no active terminal, agent, or pipeline work at the moment.'),
    ).toBeVisible();
    await expect(row).toHaveCount(0);

    await page.getByRole('button', { name: /^all \d+$/ }).click();
    await expect(page.getByRole('button').filter({ hasText: 'test' }).first()).toBeVisible();
    await expect(page.getByText('done', { exact: true }).first()).toBeVisible();
  });

  test('history parent run updates nested release outcome from running to done without reload', async ({
    page,
  }) => {
    let serveReleaseRunning = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const releaseRunning = serveReleaseRunning;
        const ts = now();
        route.fulfill({
          json: {
            jobs: [
              {
                id: 'chat-owned-release-parent',
                project: PROJECT,
                kind: 'run',
                prompt: 'Ship the completed terminal work',
                user_prompt: 'Ship the completed terminal work',
                status: 'done',
                exit_code: 0,
                started_at: ts - 240,
                finished_at: ts - 220,
                pid: 0,
                log_path: '',
                seen: true,
                session_id: 'sess-owned-release',
                work_summary: 'Terminal work completed',
              },
              {
                id: 'chat-owned-release',
                project: PROJECT,
                kind: 'release',
                prompt: null,
                status: releaseRunning ? 'running' : 'done',
                exit_code: releaseRunning ? null : 0,
                started_at: ts - 200,
                finished_at: releaseRunning ? null : ts - 5,
                pid: 0,
                log_path: '',
                seen: true,
                parent_job_id: 'chat-owned-release-parent',
              },
              {
                id: 'chat-owned-release-review',
                project: PROJECT,
                kind: 'review',
                prompt: 'Review shipped work',
                status: releaseRunning ? 'running' : 'done',
                exit_code: releaseRunning ? null : 0,
                started_at: ts - 180,
                finished_at: releaseRunning ? null : ts - 20,
                pid: 0,
                log_path: '',
                seen: true,
                release_id: 'chat-owned-release',
                parent_job_id: 'chat-owned-release',
                verdict: releaseRunning ? null : 'LGTM',
              },
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    const ownerRow = page.getByRole('button')
      .filter({ hasText: 'Ship the completed terminal work' })
      .first();
    await expect(ownerRow).toBeVisible({ timeout: 8_000 });
    await expect(ownerRow.getByText('release running', { exact: true })).toBeVisible();
    await expect(ownerRow.getByLabel('running')).toBeVisible();

    serveReleaseRunning = false;

    await expect(ownerRow.getByText('✓ release done', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(ownerRow.getByText('release running', { exact: true })).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(ownerRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });
    await expect(ownerRow.locator('[aria-label="done"]')).toBeVisible();
  });
});

// ─── Test 2a: Live running → failed transition ───────────────────────────────
//
// Mirrors the running→done test above but for the failure case.
// Verifies that when a running job transitions to done with exit_code=1 the UI
// shows the "exit 1" failure badge on the next poll cycle, with no spinner left.

test.describe('Auto-polling live update: running → failed', () => {
  test('history tab transitions running→exit 1 via 5s poll cycle without page reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'fail-poll-job',
                PROJECT,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : 1,
                'test',
              ),
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Phase 1: job is running — confirm badge is visible.
    const row = page.getByRole('button').filter({ hasText: 'Test run' }).first();
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    // Flip mock so next poll returns the failed state.
    serveRunning = false;

    // Phase 2: polling picks up failure without a page reload.
    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history tab shows the failed job reason after a running job exits non-zero', async ({
    page,
  }) => {
    let serveRunning = true;
    const failureReason = 'Review failed because the release notes step timed out.';

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              {
                ...makeJob(
                  'fail-poll-reason-job',
                  PROJECT,
                  serveRunning ? 'running' : 'done',
                  serveRunning ? null : 1,
                  'test',
                ),
                work_summary: serveRunning ? 'Running release checks…' : failureReason,
              },
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button').filter({ hasText: 'Test run' }).first();
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    serveRunning = false;

    await expect(row.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.getByText(failureReason)).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
  });

  test('history tab transitions a running review to "review verdict missing" without reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              {
                ...makeJob(
                  'review-verdict-missing-job',
                  PROJECT,
                  serveRunning ? 'running' : 'done',
                  serveRunning ? null : 0,
                  'review',
                ),
                work_summary: serveRunning
                  ? 'Review is still running.'
                  : 'Review finished without writing a formal verdict line.',
              },
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    const row = page.getByRole('button').filter({ hasText: 'Code review' }).first();
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    serveRunning = false;

    await expect(row.getByText('review verdict missing', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(row.getByText('Review finished without writing a formal verdict line.')).toBeVisible({
      timeout: 12_000,
    });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
  });
});

// ─── Test 2b: Live running → cancelled transition ────────────────────────────
//
// Verifies that a running job that transitions to done with exit_code=-3
// (aborted pipeline) shows the "cancelled" badge on the next poll cycle,
// with no orphaned spinner remaining.
// RunRow maps exit_code=-3 to the "cancelled" label via statusFailureLabel.

test.describe('Auto-polling live update: running → cancelled', () => {
  test('history tab transitions running→cancelled via 5s poll cycle without page reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [
              makeJob(
                'cancel-poll-job',
                PROJECT,
                serveRunning ? 'running' : 'done',
                serveRunning ? null : -3,
                'test',
              ),
            ],
            pendingReleaseProjects: [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    // Phase 1: running badge visible initially.
    const row = page.getByRole('button').filter({ hasText: 'Test run' }).first();
    await expect(row.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });

    // Flip mock so the next poll delivers the cancelled state.
    serveRunning = false;

    // Phase 2: "cancelled" badge appears (exit_code=-3 maps to label "cancelled");
    // no spinner remains.
    await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(row.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
  });
});

// ─── Test 2c: Pending release banner clears after poll ──────────────────────
//
// ProjectRunsTab also polls pendingReleaseProjects from /api/jobs. Verify the
// queued-release banner appears while the project is marked pending, then
// disappears on the next poll cycle without a page reload.

test.describe('Auto-polling live update: pending release banner', () => {
  test('history tab shows the queued release banner when pendingReleaseProjects gains the project', async ({
    page,
  }) => {
    let queued = false;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [],
            pendingReleaseProjects: queued ? [PROJECT] : [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    await expect(
      page.getByText(/Release queued — will fire automatically/i),
    ).toHaveCount(0, { timeout: 8_000 });

    queued = true;

    const banner = page.getByRole('link', {
      name: /Release queued — will fire automatically/i,
    });
    await expect(banner).toBeVisible({ timeout: 12_000 });
    await expect(banner).toHaveAttribute('href', `/pipeline?project=${PROJECT}`);
  });

  test('history tab clears the queued release banner when pendingReleaseProjects no longer includes the project', async ({
    page,
  }) => {
    let queued = true;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        route.fulfill({
          json: {
            jobs: [],
            pendingReleaseProjects: queued ? [PROJECT] : [],
          },
        });
      },
    );

    await page.goto(`/project/${PROJECT}/history`);

    await expect(
      page.getByText(/Release queued — will fire automatically/i),
    ).toBeVisible({ timeout: 8_000 });

    queued = false;

    await expect(
      page.getByText(/Release queued — will fire automatically/i),
    ).not.toBeVisible({ timeout: 12_000 });
  });
});

type WorkflowRunSummary = {
  id: string;
  name: string;
  rawName: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
};

function makeWorkflowRun(
  project: string,
  status: WorkflowRunSummary['status'],
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  return {
    id: `workflow-${project}`,
    name: 'release-orchestrator',
    rawName: 'release-orchestrator',
    status,
    createdAt: '2026-05-29T10:00:00.000Z',
    startedAt: '2026-05-29T10:00:02.000Z',
    completedAt: terminal ? '2026-05-29T10:00:14.000Z' : null,
    durationMs: terminal ? 12_000 : null,
    input: [project, { triggeredBy: `agent-${project}` }],
    output: null,
    error: null,
    ...overrides,
  };
}

async function stubWorkflowRunsShell(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && !url.searchParams.has('project'),
    (route: Route) =>
      route.fulfill({ json: { jobs: [], total: 0, pendingReleaseProjects: [] } }),
  );
}

async function stubWorkflowRuns(
  page: import('@playwright/test').Page,
  runs: () => WorkflowRunSummary[],
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/workflow-runs' && url.searchParams.get('limit') === '100',
    (route: Route) =>
      route.fulfill({
        json: {
          runs: runs(),
          meta: {
            workflowEnabled: true,
            releaseWorkflow: true,
            releaseWorkflowDrive: true,
            mode: 'drive',
          },
        },
      }),
  );
}

// ─── Test 2e: Workflow runs page live polling ───────────────────────────────
//
// The legacy /runs route no longer exists. Keep the live multi-project polling
// coverage on /workflow-runs, which is the supported global activity surface.

test.describe('Workflow runs page live polling', () => {
  test('/workflow-runs shows independent active runs across projects and isolates one completion', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    const alpha = 'workflow-alpha-project';
    const beta = 'workflow-beta-project';
    let phase: 'both-running' | 'alpha-completed' = 'both-running';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () =>
      phase === 'both-running'
        ? [
            makeWorkflowRun(alpha, 'running'),
            makeWorkflowRun(beta, 'running'),
          ]
        : [
            makeWorkflowRun(alpha, 'completed', { output: { verdict: 'LGTM' } }),
            makeWorkflowRun(beta, 'running'),
          ],
    );

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByRole('link', { name: new RegExp(alpha, 'i') })).toBeVisible({
      timeout: 8_000,
    });
    await expect(activePanel.getByRole('link', { name: new RegExp(beta, 'i') })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 8_000 });

    await page.getByRole('button', { name: /running 2/i }).click();
    await expect(page.getByRole('row').filter({ hasText: /release orchestrator/i })).toHaveCount(2);

    phase = 'alpha-completed';

    await expect(activePanel.getByText('1 run')).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByRole('link', { name: new RegExp(alpha, 'i') })).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(activePanel.getByRole('link', { name: new RegExp(beta, 'i') })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });

    await page.getByRole('button', { name: /all \d+/i }).click();

    const completedRow = page.getByRole('row').filter({ hasText: alpha }).first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    expect(reactKeyWarnings).toEqual([]);
  });

  test('/workflow-runs transitions running runs to completed, failed, and cancelled without reload', async ({
    page,
  }) => {
    const doneProject = 'workflow-runs-poll-done';
    const failedProject = 'workflow-runs-poll-failed';
    const cancelledProject = 'workflow-runs-poll-cancelled';
    const failureReason = 'Push failed because the remote hook rejected the branch.';
    let terminal = false;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      terminal
        ? makeWorkflowRun(doneProject, 'completed', { output: { verdict: 'LGTM' } })
        : makeWorkflowRun(doneProject, 'running'),
      terminal
        ? makeWorkflowRun(failedProject, 'failed', { error: failureReason })
        : makeWorkflowRun(failedProject, 'running'),
      terminal
        ? makeWorkflowRun(cancelledProject, 'cancelled', {
            error: 'release was cancelled before completion',
          })
        : makeWorkflowRun(cancelledProject, 'running'),
    ]);

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByText('3 runs')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('3 running')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /failed 1/i })).toHaveCount(0);

    terminal = true;

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const doneRow = page.getByRole('row').filter({ hasText: doneProject }).first();
    const failedRow = attentionPanel.getByRole('link', { name: new RegExp(failedProject, 'i') }).first();
    const cancelledRow = attentionPanel.getByRole('link', { name: new RegExp(cancelledProject, 'i') }).first();

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(doneRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(doneRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    await expect(failedRow.getByLabel('status failed')).toBeVisible({ timeout: 12_000 });
    await expect(failedRow.getByText(failureReason)).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByTitle('release was cancelled before completion')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('3 running')).toHaveCount(0, { timeout: 12_000 });

    const failedFilter = page.getByRole('button', { name: /failed 1/i });
    await expect(failedFilter).toBeVisible({ timeout: 12_000 });
    await failedFilter.click();
    await expect(failedRow).toBeVisible();
    await expect(doneRow).toHaveCount(0);
    await expect(cancelledRow).toHaveCount(0);
  });
});

// ─── Test 2d: Project history concurrent rows ───────────────────────────────
//
// ProjectRunsTab groups and re-renders rows on every poll tick. Verify two
// active rows in the same project stay independent as one completes, and
// confirm React does not emit duplicate-key warnings while doing so.

test.describe('Project history concurrent rows', () => {
  test('history tab shows two simultaneous running rows without React key warnings', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    const reviewStartedAt = now() - 60;
    const testStartedAt = now() - 55;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob('history-review-running', PROJECT, 'running', null, 'review', {
                startedAt: reviewStartedAt,
              }),
              makeJob('history-test-running', PROJECT, 'running', null, 'test', {
                startedAt: testStartedAt,
              }),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}/history`);

    const pipelineRow = historyRowByTitle(page, 'Pipeline steps');
    const reviewRow = historyRowByTitle(page, 'Code review');
    const testRow = historyRowByTitle(page, 'Test run');

    await expect(pipelineRow).toBeVisible({ timeout: 8_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await pipelineRow.getByRole('button', { name: '▸' }).click();
    await expect(reviewRow).toBeVisible({ timeout: 8_000 });
    await expect(testRow).toBeVisible({ timeout: 8_000 });
    await expect(reviewRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await expect(testRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(3, { timeout: 8_000 });
    expect(reactKeyWarnings).toEqual([]);
  });

  test('history tab keeps concurrent rows isolated when one job finishes and the other keeps running', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    let testDone = false;
    const reviewStartedAt = now() - 60;
    const testStartedAt = now() - 55;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob('history-review-running', PROJECT, 'running', null, 'review', {
                startedAt: reviewStartedAt,
              }),
              makeJob(
                'history-test-transition',
                PROJECT,
                testDone ? 'done' : 'running',
                testDone ? 0 : null,
                'test',
                {
                  startedAt: testStartedAt,
                  finishedAt: testDone ? testStartedAt + 20 : null,
                },
              ),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}/history`);

    const pipelineRow = historyRowByTitle(page, 'Pipeline steps');
    const reviewRow = historyRowByTitle(page, 'Code review');
    const testRow = historyRowByTitle(page, 'Test run');

    await expect(pipelineRow).toBeVisible({ timeout: 8_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await pipelineRow.getByRole('button', { name: '▸' }).click();
    await expect(reviewRow).toBeVisible({ timeout: 8_000 });
    await expect(testRow).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(3, { timeout: 8_000 });

    testDone = true;

    await expect(testRow.getByText('done', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(testRow.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(reviewRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(2, { timeout: 12_000 });
    expect(reactKeyWarnings).toEqual([]);
  });

  test('history tab keeps concurrent rows isolated when one job is cancelled and the other keeps running', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    let testCancelled = false;
    const reviewStartedAt = now() - 60;
    const testStartedAt = now() - 55;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              makeJob('history-review-running', PROJECT, 'running', null, 'review', {
                startedAt: reviewStartedAt,
              }),
              makeJob(
                'history-test-cancel-transition',
                PROJECT,
                testCancelled ? 'done' : 'running',
                testCancelled ? -3 : null,
                'test',
                {
                  startedAt: testStartedAt,
                  finishedAt: testCancelled ? testStartedAt + 20 : null,
                },
              ),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}/history`);

    const pipelineRow = historyRowByTitle(page, 'Pipeline steps');
    const reviewRow = historyRowByTitle(page, 'Code review');
    const testRow = historyRowByTitle(page, 'Test run');

    await expect(pipelineRow).toBeVisible({ timeout: 8_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await pipelineRow.getByRole('button', { name: '▸' }).click();
    await expect(reviewRow).toBeVisible({ timeout: 8_000 });
    await expect(testRow).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(3, { timeout: 8_000 });

    testCancelled = true;

    await expect(testRow.getByText('cancelled', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(testRow.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(reviewRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(2, { timeout: 12_000 });
    expect(reactKeyWarnings).toEqual([]);
  });

  test('history tab keeps concurrent rows isolated when one job fails and the other keeps running', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    const failureReason = 'Tests failed after the smoke check timed out.';
    let testFailed = false;
    const reviewStartedAt = now() - 60;
    const testStartedAt = now() - 55;

    await stubCommonRoutes(page, PROJECT);

    await page.route(
      (url) =>
        url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              {
                ...makeJob('history-review-running', PROJECT, 'running', null, 'review', {
                  startedAt: reviewStartedAt,
                }),
                work_summary: 'Code review is still running.',
              },
              {
                ...makeJob(
                  'history-test-fail-transition',
                  PROJECT,
                  testFailed ? 'done' : 'running',
                  testFailed ? 1 : null,
                  'test',
                  {
                    startedAt: testStartedAt,
                    finishedAt: testFailed ? testStartedAt + 20 : null,
                  },
                ),
                work_summary: testFailed ? failureReason : 'Tests are still running.',
              },
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}/history`);

    const pipelineRow = historyRowByTitle(page, 'Pipeline steps');
    const reviewRow = historyRowByTitle(page, 'Code review');
    const testRow = historyRowByTitle(page, 'Test run');

    await expect(pipelineRow).toBeVisible({ timeout: 8_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 8_000 });
    await pipelineRow.getByRole('button', { name: '▸' }).click();
    await expect(reviewRow).toBeVisible({ timeout: 8_000 });
    await expect(testRow).toBeVisible({ timeout: 8_000 });
    await expect(runningRunRows(page)).toHaveCount(3, { timeout: 8_000 });

    testFailed = true;

    await expect(testRow.getByText('exit 1', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(testRow.getByText(failureReason)).toBeVisible({ timeout: 12_000 });
    await expect(testRow.locator('[aria-label="running"]')).toHaveCount(0, { timeout: 12_000 });
    await expect(reviewRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineRow.locator('[aria-label="running"]')).toBeVisible({ timeout: 12_000 });
    await expect(runningRunRows(page)).toHaveCount(2, { timeout: 12_000 });
    expect(reactKeyWarnings).toEqual([]);
  });
});
