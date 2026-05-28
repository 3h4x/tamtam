import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'retrieval-ui';

function makeTask() {
  return {
    id: `${PROJECT}-config`,
    project: PROJECT,
    job: null,
    priority: null,
    paused: false,
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
    auto_commit_enabled: false,
    auto_push_enabled: false,
    auto_pr_merge_enabled: false,
    post_merge_watch_minutes: 0,
    auto_revert_enabled: false,
    release_after_run: false,
    issue_auto_branch: true,
    tests_disabled: true,
    review_disabled: false,
    review_prompt_addendum: '',
    review_prerequisite_command: '',
    fix_prompt_addendum: '',
    commit_style: '',
    website: '',
    qa_url: '',
  };
}

async function stubProjectConfigShell(page: Page, retrievalEnabled: boolean): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask()], priorities: [], issueCounts: {} },
    }),
  );
  await page.route('**/api/settings', (route: Route) =>
    route.fulfill({
      json: {
        settings: {
          jobs_paused: 'false',
          github_board_view_url: '',
          retrieval_enabled: String(retrievalEnabled),
        },
      },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/config`, (route: Route) =>
    route.fulfill({ json: makeProjectConfig() }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/action`, (route: Route) =>
    route.fulfill({ json: { actions: [] } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/issues?summary=1`, (route: Route) =>
    route.fulfill({
      json: {
        repo: '',
        prCount: 0,
        issueCount: 0,
        openPrBranches: [],
        error: null,
        cached: true,
        cachedAt: Date.now(),
      },
    }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/branch`, (route: Route) =>
    route.fulfill({ json: { branch: 'master', defaultBranch: 'master', commitsAhead: 0 } }),
  );
  await page.route(`**/api/projects/by-project/${PROJECT}/behind`, (route: Route) =>
    route.fulfill({ json: { behind: 0, ahead: 0 } }),
  );
  await page.route(
    (url) => url.pathname === '/api/jobs' && url.searchParams.get('project') === PROJECT,
    (route: Route) => route.fulfill({ json: { jobs: [], pendingReleaseProjects: [] } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
}

test.describe('Retrieval reindex UI', () => {
  test('shows enabled status from nested settings payload and refreshes stats after reindex', async ({ page }) => {
    let statsRequestCount = 0;
    let reindexRequested = false;

    await stubProjectConfigShell(page, true);
    await page.route(`**/api/projects/${PROJECT}/retrieval/stats`, (route: Route) => {
      statsRequestCount += 1;
      route.fulfill({
        json: reindexRequested
          ? { records: 3, chunks: 18 }
          : { records: 2, chunks: 12 },
      });
    });
    await page.route(`**/api/projects/${PROJECT}/retrieval/reindex`, (route: Route) => {
      reindexRequested = true;
      route.fulfill({ json: { chunks: 18, indexedSources: 3, skippedSources: 1 } });
    });

    await page.goto(`/project/${PROJECT}/config`);

    await expect(page.getByRole('heading', { name: 'Retrieval (Embeddings)' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('Enabled').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('2').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('12').first()).toBeVisible({ timeout: 8_000 });

    const reindexButton = page.getByRole('button', { name: 'Reindex now' });
    await expect(reindexButton).toBeEnabled();
    await reindexButton.click();

    await expect(page.getByText('Reindex complete')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('18 chunks, 3 indexed, 1 skipped')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('3').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('18').first()).toBeVisible({ timeout: 8_000 });
    expect(statsRequestCount).toBeGreaterThanOrEqual(2);
  });

  test('disables reindex button when retrieval is off globally', async ({ page }) => {
    await stubProjectConfigShell(page, false);
    await page.route(`**/api/projects/${PROJECT}/retrieval/stats`, (route: Route) =>
      route.fulfill({ json: { records: 0, chunks: 0 } }),
    );
    await page.route(`**/api/projects/${PROJECT}/retrieval/reindex`, (route: Route) =>
      route.fulfill({ status: 500, json: { error: 'should not be called' } }),
    );

    await page.goto(`/project/${PROJECT}/config`);

    await expect(page.getByText('Disabled (Settings → General)')).toBeVisible({ timeout: 8_000 });
    const reindexButton = page.getByRole('button', { name: 'Reindex now' });
    await expect(reindexButton).toBeDisabled();
    await expect(reindexButton).toHaveAttribute('title', 'Enable retrieval in Settings → General');
  });
});
