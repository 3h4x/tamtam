import type { Page, Route } from '@playwright/test';

// Live-update UI tests — verify auto-polling state transitions and concurrent
// multi-project job visibility without page reload.
//
// Uses page.route() to intercept API calls; no real pipeline execution is
// involved (no Claude shim, no git shim, no PM2 jobs).

export const PROJECT = 'lifecycle-ui'; // reuse the mocked-API project from job-lifecycle-ui.spec.ts

export const now = () => Math.floor(Date.now() / 1000);

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

export function makeJob(
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

export function runRow(page: Page, project: string) {
  return page.getByRole('button').filter({ hasText: project }).first();
}

export function runningRunRows(page: Page) {
  return page.getByRole('button').filter({ has: page.locator('[aria-label="running"]') });
}

export function historyRowByTitle(page: Page, title: string) {
  return page.getByRole('button').filter({ hasText: title }).first();
}

export function statusFilterButton(
  page: Page,
  label: 'running' | 'done' | 'failed',
) {
  return page.getByRole('button', { name: new RegExp(`^${label} \\d+$`) }).first();
}

export function captureReactKeyWarnings(page: Page) {
  const warnings: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Each child in a list should have a unique "key" prop/.test(text)) {
      warnings.push(text);
    }
  });
  return warnings;
}

export async function stubCommonRoutes(
  page: Page,
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

export type WorkflowRunSummary = {
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

export function makeWorkflowRun(
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

export async function stubWorkflowRunsShell(page: Page): Promise<void> {
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

export async function stubWorkflowRuns(
  page: Page,
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
