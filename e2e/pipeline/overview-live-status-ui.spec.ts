import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'overview-live-ui';
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
    ...overrides,
  };
}

async function stubOverviewRoutes(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask(PROJECT)], priorities: [], issueCounts: {} },
    }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) =>
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
  await page.route(
    `**/api/projects/by-project/${PROJECT}/action`,
    (route: Route) => route.fulfill({ json: { actions: [] } }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/issues?summary=1`,
    (route: Route) =>
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
  await page.route(
    `**/api/projects/by-project/${PROJECT}/branch`,
    (route: Route) =>
      route.fulfill({
        json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 },
      }),
  );
  await page.route(
    `**/api/projects/by-project/${PROJECT}/behind`,
    (route: Route) => route.fulfill({ json: { behind: 0, ahead: 0 } }),
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
}

test.describe('Overview tab live status polling', () => {
  test('agent active-work card clears after the agent run finishes without reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: serveRunning
              ? [
                  makeJob('agent-live', 'agent:research', 'running', null, {
                    provider: 'claude',
                    user_prompt: 'Research release blockers',
                    prompt: 'Research release blockers',
                  }),
                ]
              : [
                  makeJob('agent-live', 'agent:research', 'done', 0, {
                    provider: 'claude',
                    user_prompt: 'Research release blockers',
                    prompt: 'Research release blockers',
                    finished_at: now() - 5,
                  }),
                ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('active work')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /research/i }).first()).toBeVisible({
      timeout: 8_000,
    });

    serveRunning = false;

    await expect(page.getByText('active work')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('1 running now')).toHaveCount(0, { timeout: 12_000 });
  });

  test('release active-work card uses its parent agent identity while the release is running', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: serveRunning
              ? [
                  makeJob('release-live', 'release', 'running', null, {
                    parent_job_id: 'agent-parent-live',
                    provider: 'claude',
                  }),
                  makeJob('agent-parent-live', 'agent:improve', 'done', 0, {
                    provider: 'claude',
                    finished_at: now() - 15,
                  }),
                ]
              : [
                  makeJob('release-live', 'release', 'done', 0, {
                    parent_job_id: 'agent-parent-live',
                    finished_at: now() - 5,
                    work_summary: 'Released successfully.',
                  }),
                  makeJob('agent-parent-live', 'agent:improve', 'done', 0, {
                    provider: 'claude',
                    finished_at: now() - 15,
                  }),
                ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('active work')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /improve/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('release in progress')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Release pipeline')).toHaveCount(0);

    serveRunning = false;

    await expect(page.getByText('active work')).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByText('release in progress')).toHaveCount(0, { timeout: 12_000 });
  });

  test('review card flips from running to LGTM and clears the active-work banner without reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              serveRunning
                ? makeJob('review-live', 'review', 'running', null)
                : makeJob('review-live', 'review', 'done', 0, {
                    verdict: 'LGTM',
                    session_id: 'sess-review-live',
                  }),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /review running/i }).first()).toBeVisible({
      timeout: 8_000,
    });

    serveRunning = false;

    await expect(page.getByText('1 running now')).not.toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /review LGTM/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /review running/i })).toHaveCount(0);
  });

  test('tests card flips from running to failed exit code and clears the active-work banner without reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              serveRunning
                ? makeJob('test-live', 'test', 'running', null)
                : makeJob('test-live', 'test', 'done', 1),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /tests running/i }).first()).toBeVisible({
      timeout: 8_000,
    });

    serveRunning = false;

    await expect(page.getByText('1 running now')).not.toBeVisible({ timeout: 12_000 });
    await expect(
      page.getByRole('button', { name: /tests Failed \(exit 1\)/i }).first(),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /tests running/i })).toHaveCount(0);
  });

  test('review card flips from running to DO NOT SHIP and clears the active-work banner without reload', async ({
    page,
  }) => {
    let serveRunning = true;

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) =>
        route.fulfill({
          json: {
            jobs: [
              serveRunning
                ? makeJob('review-dns-live', 'review', 'running', null)
                : makeJob('review-dns-live', 'review', 'done', 0, {
                    verdict: 'DO NOT SHIP',
                    session_id: 'sess-review-dns-live',
                  }),
            ],
            pendingReleaseProjects: [],
          },
        }),
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /review running/i }).first()).toBeVisible({
      timeout: 8_000,
    });

    serveRunning = false;

    await expect(page.getByText('1 running now')).not.toBeVisible({ timeout: 12_000 });
    await expect(
      page.getByRole('button', { name: /review do not ship/i }).first(),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /review running/i })).toHaveCount(0);
  });

  test('overview keeps concurrent review and test transitions isolated as one finishes and the other keeps running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'review-done' | 'all-done' = 'both-running';

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs =
          phase === 'both-running'
            ? [
                makeJob('review-live', 'review', 'running', null),
                makeJob('test-live', 'test', 'running', null),
              ]
            : phase === 'review-done'
              ? [
                  makeJob('review-live', 'review', 'done', 0, {
                    verdict: 'LGTM',
                    session_id: 'sess-review-live',
                  }),
                  makeJob('test-live', 'test', 'running', null),
                ]
              : [
                  makeJob('review-live', 'review', 'done', 0, {
                    verdict: 'LGTM',
                    session_id: 'sess-review-live',
                  }),
                  makeJob('test-live', 'test', 'done', 0),
                ];

        route.fulfill({ json: { jobs, pendingReleaseProjects: [] } });
      },
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('2 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /review running/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: /tests running/i }).first()).toBeVisible({
      timeout: 8_000,
    });

    phase = 'review-done';

    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /review LGTM/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /tests running/i }).first()).toBeVisible({
      timeout: 12_000,
    });

    phase = 'all-done';

    await expect(page.getByText('1 running now')).not.toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /review LGTM/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /tests Passed/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /tests running/i })).toHaveCount(0);
  });

  test('overview keeps concurrent transitions isolated when one job is cancelled and the other keeps running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'review-cancelled' | 'all-done' = 'both-running';

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs =
          phase === 'both-running'
            ? [
                makeJob('review-cancel-live', 'review', 'running', null),
                makeJob('test-steady-live', 'test', 'running', null),
              ]
            : phase === 'review-cancelled'
              ? [
                  makeJob('review-cancel-live', 'review', 'done', -3, {
                    session_id: 'sess-review-cancel-live',
                  }),
                  makeJob('test-steady-live', 'test', 'running', null),
                ]
              : [
                  makeJob('review-cancel-live', 'review', 'done', -3, {
                    session_id: 'sess-review-cancel-live',
                  }),
                  makeJob('test-steady-live', 'test', 'done', 0),
                ];

        route.fulfill({ json: { jobs, pendingReleaseProjects: [] } });
      },
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('2 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /review running/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: /tests running/i }).first()).toBeVisible({
      timeout: 8_000,
    });

    phase = 'review-cancelled';

    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /review not run yet/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /tests running/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /review running/i })).toHaveCount(0);

    phase = 'all-done';

    await expect(page.getByText('1 running now')).not.toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /tests Passed/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /tests running/i })).toHaveCount(0);
  });

  test('overview keeps concurrent transitions isolated when one review fails while tests keep running', async ({
    page,
  }) => {
    let phase: 'both-running' | 'review-failed' | 'all-done' = 'both-running';

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs =
          phase === 'both-running'
            ? [
                makeJob('review-fail-live', 'review', 'running', null),
                makeJob('test-steady-failure-live', 'test', 'running', null),
              ]
            : phase === 'review-failed'
              ? [
                  makeJob('review-fail-live', 'review', 'done', 0, {
                    verdict: 'DO NOT SHIP',
                    session_id: 'sess-review-fail-live',
                  }),
                  makeJob('test-steady-failure-live', 'test', 'running', null),
                ]
              : [
                  makeJob('review-fail-live', 'review', 'done', 0, {
                    verdict: 'DO NOT SHIP',
                    session_id: 'sess-review-fail-live',
                  }),
                  makeJob('test-steady-failure-live', 'test', 'done', 0),
                ];

        route.fulfill({ json: { jobs, pendingReleaseProjects: [] } });
      },
    );

    await page.goto(`/project/${PROJECT}`);

    await expect(page.getByText('2 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /review running/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: /tests running/i }).first()).toBeVisible({
      timeout: 8_000,
    });

    phase = 'review-failed';

    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 12_000 });
    await expect(
      page.getByRole('button', { name: /review do not ship/i }).first(),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /tests running/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /review running/i })).toHaveCount(0);

    phase = 'all-done';

    await expect(page.getByText('1 running now')).not.toBeVisible({ timeout: 12_000 });
    await expect(
      page.getByRole('button', { name: /review do not ship/i }).first(),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: /tests Passed/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByRole('button', { name: /tests running/i })).toHaveCount(0);
  });

  test('active-work overflow count clears when one of five running jobs finishes', async ({
    page,
  }) => {
    let phase: 'five-running' | 'four-running' = 'five-running';
    const baseStarted = now() - 10;

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        const jobs = [
          makeJob('overflow-agent-live', 'agent:research', 'running', null, {
            started_at: baseStarted + 4,
            provider: 'claude',
            user_prompt: 'Map the rollout risk',
            prompt: 'Map the rollout risk',
          }),
          makeJob('overflow-run-live', 'run', 'running', null, {
            started_at: baseStarted + 3,
            user_prompt: 'Investigate the latest failed workflow',
            prompt: 'Investigate the latest failed workflow',
          }),
          makeJob('overflow-review-live', 'review', 'running', null, {
            started_at: baseStarted + 2,
          }),
          makeJob('overflow-test-live', 'test', 'running', null, {
            started_at: baseStarted + 1,
          }),
          makeJob(
            'overflow-push-live',
            'push',
            phase === 'five-running' ? 'running' : 'done',
            phase === 'five-running' ? null : 0,
            {
              started_at: baseStarted,
              finished_at: phase === 'five-running' ? null : now() - 1,
            },
          ),
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

    phase = 'four-running';

    await expect(page.getByText('4 running now')).toBeVisible({ timeout: 12_000 });
    await expect(activeWork.getByText('+1 more running job')).toHaveCount(0, { timeout: 12_000 });
    await expect(activeWork.getByRole('button', { name: /push/i })).toHaveCount(0);
    await expect(activeWork.getByRole('button', { name: /agent/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(activeWork.getByRole('button', { name: /chat/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(activeWork.getByRole('button', { name: /code review/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(activeWork.getByRole('button', { name: /test run/i }).first()).toBeVisible({
      timeout: 12_000,
    });
  });

  test('active-work overflow shows the plural count and decrements live as hidden jobs finish', async ({
    page,
  }) => {
    // 6 concurrent running jobs → 4 cards visible, 2 hidden → "+2 more running jobs"
    // (plural). As the two oldest (hidden) jobs finish one at a time the banner
    // must read "+1 more running job" (singular) and then clear entirely, while
    // the four newest cards stay put. Exercises the pluralization branch in
    // OverviewTab that the live e2e suite otherwise only covers in the singular.
    let phase: 'six' | 'five' | 'four' = 'six';
    const baseStarted = now() - 20;

    await stubOverviewRoutes(page);
    await page.route(
      (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
      (route: Route) => {
        // Visible (4 newest, always running): agent, run, review, test.
        const visible = [
          makeJob('plural-agent-live', 'agent:research', 'running', null, {
            started_at: baseStarted + 5,
            provider: 'claude',
            user_prompt: 'Map the rollout risk',
            prompt: 'Map the rollout risk',
          }),
          makeJob('plural-run-live', 'run', 'running', null, {
            started_at: baseStarted + 4,
            user_prompt: 'Investigate the latest failed workflow',
            prompt: 'Investigate the latest failed workflow',
          }),
          makeJob('plural-review-live', 'review', 'running', null, {
            started_at: baseStarted + 3,
          }),
          makeJob('plural-test-live', 'test', 'running', null, {
            started_at: baseStarted + 2,
          }),
        ];
        // Hidden (2 oldest): commit then push. They finish first so the visible
        // set never changes — only the overflow banner moves.
        const hiddenCommit = makeJob(
          'plural-commit-live',
          'commit',
          phase === 'six' ? 'running' : 'done',
          phase === 'six' ? null : 0,
          {
            started_at: baseStarted + 1,
            finished_at: phase === 'six' ? null : now() - 1,
          },
        );
        const hiddenPush = makeJob(
          'plural-push-live',
          'push',
          phase === 'four' ? 'done' : 'running',
          phase === 'four' ? 0 : null,
          {
            started_at: baseStarted,
            finished_at: phase === 'four' ? now() - 1 : null,
          },
        );

        route.fulfill({
          json: { jobs: [...visible, hiddenCommit, hiddenPush], pendingReleaseProjects: [] },
        });
      },
    );

    await page.goto(`/project/${PROJECT}`);

    const activeWork = page.locator('section').filter({ hasText: 'active work' }).first();

    await expect(page.getByText('6 running now')).toBeVisible({ timeout: 8_000 });
    await expect(activeWork.getByText('+2 more running jobs')).toBeVisible({ timeout: 8_000 });
    await expect(activeWork.getByRole('button', { name: /agent/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(activeWork.getByRole('button', { name: /code review/i }).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(activeWork.getByRole('button', { name: /commit/i })).toHaveCount(0);
    await expect(activeWork.getByRole('button', { name: /push/i })).toHaveCount(0);

    phase = 'five';

    await expect(page.getByText('5 running now')).toBeVisible({ timeout: 12_000 });
    await expect(activeWork.getByText('+1 more running job')).toBeVisible({ timeout: 12_000 });
    await expect(activeWork.getByText('+2 more running jobs')).toHaveCount(0, { timeout: 12_000 });
    await expect(activeWork.getByRole('button', { name: /commit/i })).toHaveCount(0);
    await expect(activeWork.getByRole('button', { name: /push/i })).toHaveCount(0);

    phase = 'four';

    await expect(page.getByText('4 running now')).toBeVisible({ timeout: 12_000 });
    await expect(activeWork.getByText(/more running job/)).toHaveCount(0, { timeout: 12_000 });
    await expect(activeWork.getByRole('button', { name: /agent/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(activeWork.getByRole('button', { name: /test run/i }).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(activeWork.getByRole('button', { name: /push/i })).toHaveCount(0);
  });
});
