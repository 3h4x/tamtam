import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'overview-strip-pipeline-ui';

const now = () => Math.floor(Date.now() / 1000);

type Phase =
  | 'test'
  | 'review'
  | 'fix'
  | 'retest'
  | 'rereview'
  | 'commit'
  | 'push'
  | 'done';

type MockJob = {
  id: string;
  project: string;
  kind: string;
  status: 'done' | 'running';
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  pid: number;
  log_path: string;
  seen: boolean;
  session_id: string | null;
  release_id?: string | null;
  context_meta: string | null;
  provider: string;
  work_summary: string;
  verdict?: string;
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
    changes: 1,
    unpushed: 0,
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

function makeProjectConfig() {
  return {
    project: PROJECT,
    test_command: 'pnpm test',
    detected_test_command: '',
    effective_test_command: 'pnpm test',
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
    last_push_error: null,
  };
}

function emptyIssuesSummary() {
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

function makeReleaseChain(phase: Phase): MockJob[] {
  if (phase === 'done') return [];

  const releaseId = 'overview-strip-release-1';
  const releaseJob: MockJob = {
    id: releaseId,
    project: PROJECT,
    kind: 'release',
    status: 'running',
    exit_code: null,
    started_at: now() - 120,
    finished_at: null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    context_meta: null,
    provider: 'claude',
    work_summary: 'Release pipeline is running.',
  };

  const testStep = (
    id: string,
    status: 'done' | 'running',
    exitCode: number | null,
    startedAgo = 60,
  ) => ({
    id,
    project: PROJECT,
    kind: 'test',
    status,
    exit_code: exitCode,
    started_at: now() - startedAgo,
    finished_at: status === 'done' ? now() - Math.max(startedAgo - 10, 1) : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: `${id}-session`,
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Tests are running.' : 'Tests completed.',
  });

  const reviewStep = (
    id: string,
    status: 'done' | 'running',
    verdict?: string,
    startedAgo = 45,
  ) => ({
    id,
    project: PROJECT,
    kind: 'review',
    status,
    exit_code: status === 'done' ? 0 : null,
    started_at: now() - startedAgo,
    finished_at: status === 'done' ? now() - Math.max(startedAgo - 5, 1) : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: `${id}-session`,
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Review is running.' : 'Review completed.',
    ...(verdict ? { verdict } : {}),
  });

  const fixStep = (status: 'done' | 'running') => ({
    id: 'overview-strip-fix-1',
    project: PROJECT,
    kind: 'fix',
    status,
    exit_code: status === 'done' ? 0 : null,
    started_at: now() - 30,
    finished_at: status === 'done' ? now() - 25 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: 'overview-strip-fix-session',
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Fix is running.' : 'Fix completed.',
  });

  const commitStep = (status: 'done' | 'running') => ({
    id: 'overview-strip-commit-1',
    project: PROJECT,
    kind: 'commit',
    status,
    exit_code: status === 'done' ? 0 : null,
    started_at: now() - 20,
    finished_at: status === 'done' ? now() - 15 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Commit is running.' : 'Commit completed.',
  });

  const pushStep = (status: 'done' | 'running') => ({
    id: 'overview-strip-push-1',
    project: PROJECT,
    kind: 'push',
    status,
    exit_code: status === 'done' ? 0 : null,
    started_at: now() - 10,
    finished_at: status === 'done' ? now() - 5 : null,
    pid: 0,
    log_path: '',
    seen: true,
    session_id: null,
    release_id: releaseId,
    context_meta: null,
    provider: 'claude',
    work_summary: status === 'running' ? 'Push is running.' : 'Push completed.',
  });

  if (phase === 'test') return [releaseJob, testStep('overview-strip-test-1', 'running', null)];
  if (phase === 'review') {
    return [
      releaseJob,
      testStep('overview-strip-test-1', 'done', 0),
      reviewStep('overview-strip-review-1', 'running'),
    ];
  }
  if (phase === 'fix') {
    return [
      releaseJob,
      testStep('overview-strip-test-1', 'done', 0),
      reviewStep('overview-strip-review-1', 'done', 'NEEDS ATTENTION'),
      fixStep('running'),
    ];
  }
  if (phase === 'retest') {
    return [
      releaseJob,
      testStep('overview-strip-test-1', 'done', 0),
      reviewStep('overview-strip-review-1', 'done', 'NEEDS ATTENTION'),
      fixStep('done'),
      testStep('overview-strip-test-2', 'running', null, 12),
    ];
  }
  if (phase === 'rereview') {
    return [
      releaseJob,
      testStep('overview-strip-test-1', 'done', 0),
      reviewStep('overview-strip-review-1', 'done', 'NEEDS ATTENTION'),
      fixStep('done'),
      testStep('overview-strip-test-2', 'done', 0, 18),
      reviewStep('overview-strip-review-2', 'running', undefined, 8),
    ];
  }
  if (phase === 'commit') {
    return [
      releaseJob,
      testStep('overview-strip-test-1', 'done', 0),
      reviewStep('overview-strip-review-1', 'done', 'NEEDS ATTENTION'),
      fixStep('done'),
      testStep('overview-strip-test-2', 'done', 0, 18),
      reviewStep('overview-strip-review-2', 'done', 'LGTM', 8),
      commitStep('running'),
    ];
  }
  return [
    releaseJob,
    testStep('overview-strip-test-1', 'done', 0),
    reviewStep('overview-strip-review-1', 'done', 'NEEDS ATTENTION'),
    fixStep('done'),
    testStep('overview-strip-test-2', 'done', 0, 18),
    reviewStep('overview-strip-review-2', 'done', 'LGTM', 8),
    commitStep('done'),
    pushStep('running'),
  ];
}

async function stubOverviewRoutes(
  page: Page,
  phase: () => Phase,
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
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
  await page.route(`**/api/projects/by-project/${PROJECT}/issues?summary=1`, (route: Route) =>
    route.fulfill({ json: emptyIssuesSummary() }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({ json: { settings: { jobs_paused: 'false' }, github_owner: '' } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route(
    (url) => url.pathname === '/api/agents' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) =>
      route.fulfill({
        json: { jobs: makeReleaseChain(phase()), pendingReleaseProjects: [] },
      }),
  );
}

function pipelineSummary(page: Page, label: string) {
  return page.locator(`[aria-label="pipeline summary: ${label}"]`);
}

function pipelineStep(page: Page, prefix: string) {
  return page.locator(`button[aria-label^="${prefix}"]`);
}

test.describe('Overview pipeline strip lifecycle', () => {
  test('overview strip advances through test, review, fix, commit, and push before disappearing on success', async ({
    page,
  }) => {
    let phase: Phase = 'test';
    await stubOverviewRoutes(page, () => phase);

    await page.goto(`/project/${PROJECT}`);

    await expect(pipelineSummary(page, 'test running')).toBeVisible({ timeout: 8_000 });
    await expect(pipelineStep(page, 'test: running.')).toBeVisible();

    phase = 'review';
    await expect(pipelineSummary(page, 'review running')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineStep(page, 'review: running.')).toBeVisible();

    phase = 'fix';
    await expect(pipelineSummary(page, 'fix running')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineStep(page, 'fix: running.')).toBeVisible();

    phase = 'retest';
    await expect(pipelineSummary(page, 'test running')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineStep(page, 'test: running, 2 runs.')).toBeVisible();

    phase = 'rereview';
    await expect(pipelineSummary(page, 'review running')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineStep(page, 'review: running, 2 runs.')).toBeVisible();

    phase = 'commit';
    await expect(pipelineSummary(page, 'commit running')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineStep(page, 'commit: running.')).toBeVisible();

    phase = 'push';
    await expect(pipelineSummary(page, 'push running')).toBeVisible({ timeout: 12_000 });
    await expect(pipelineStep(page, 'push: running.')).toBeVisible();

    phase = 'done';
    await expect(page.locator('[aria-label^="pipeline summary:"]')).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: 'Releasing…', exact: true })).toHaveCount(0, {
      timeout: 12_000,
    });
  });
});
