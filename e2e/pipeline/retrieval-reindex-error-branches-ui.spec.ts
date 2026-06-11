import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const PROJECT = 'retrieval-error-branches-ui';

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

// Stubs every route the config page needs EXCEPT /api/settings — callers add that.
async function stubBaseShell(page: Page): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [makeTask()], priorities: [], issueCounts: {} } }),
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

test.describe('RetrievalReindexPanel — error branches', () => {
  test('shows "…" status when settings fetch rejects', async ({ page }) => {
    await stubBaseShell(page);
    // Aborting the settings route triggers the outer catch in refreshStatus → enabled stays null → "…"
    // The shell's loadSettings also aborts but handles it with .catch(() => undefined) so the page still renders.
    await page.route('**/api/settings', (route: Route) => route.abort('failed'));
    await page.route(`**/api/projects/${PROJECT}/retrieval/stats`, (route: Route) =>
      route.fulfill({ json: { records: 5, chunks: 25 } }),
    );

    await page.goto(`/project/${PROJECT}/config`);

    await expect(page.getByRole('heading', { name: 'Retrieval (Embeddings)' })).toBeVisible({
      timeout: 8_000,
    });
    // enabled === null → Status cell renders the loading placeholder "…"
    await expect(page.getByText('…', { exact: true })).toBeVisible({ timeout: 8_000 });
    // Retrieval status is unconfirmed (settings fetch failed → enabled stays null), so the
    // button is disabled to avoid firing a reindex POST that cannot be confirmed.
    const button = page.getByRole('button', { name: 'Reindex now' });
    await expect(button).toBeDisabled({ timeout: 8_000 });
    await expect(button).toHaveAttribute('title', 'Checking retrieval status…');
  });

  test('keeps the button disabled while settings is loading, then enables it once retrieval is confirmed', async ({
    page,
  }) => {
    await stubBaseShell(page);
    await page.route(`**/api/projects/${PROJECT}/retrieval/stats`, (route: Route) =>
      route.fulfill({ json: { records: 0, chunks: 0 } }),
    );
    // Hold every /api/settings request (shell + panel) until we release them, so the
    // panel sits in the unconfirmed `enabled === null` state deterministically.
    const held: Route[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/settings', async (route: Route) => {
      held.push(route);
      await released;
      await route.fulfill({
        json: { settings: { jobs_paused: 'false', retrieval_enabled: 'true' } },
      });
    });

    await page.goto(`/project/${PROJECT}/config`);

    await expect(page.getByRole('heading', { name: 'Retrieval (Embeddings)' })).toBeVisible({
      timeout: 8_000,
    });
    // Status unknown while settings is in-flight → button disabled with the checking tooltip.
    const button = page.getByRole('button', { name: 'Reindex now' });
    await expect(button).toBeDisabled({ timeout: 8_000 });
    await expect(button).toHaveAttribute('title', 'Checking retrieval status…');

    // Release the held settings responses → retrieval confirmed enabled → button enables.
    release();
    await expect(button).toBeEnabled({ timeout: 8_000 });
    await expect(button).not.toHaveAttribute('title', 'Checking retrieval status…');
  });

  test('shows "—" for records and chunks when stats endpoint returns non-ok', async ({ page }) => {
    await stubBaseShell(page);
    await page.route('**/api/settings', (route: Route) =>
      route.fulfill({
        json: { settings: { jobs_paused: 'false', retrieval_enabled: 'true' } },
      }),
    );
    // Non-ok status → (r.ok ? r.json() : null) returns null → statsRes is null → counts stay null → "—"
    await page.route(`**/api/projects/${PROJECT}/retrieval/stats`, (route: Route) =>
      route.fulfill({ status: 500, json: { error: 'db unavailable' } }),
    );

    await page.goto(`/project/${PROJECT}/config`);

    await expect(page.getByRole('heading', { name: 'Retrieval (Embeddings)' })).toBeVisible({
      timeout: 8_000,
    });
    // Settings resolved → Status shows "Enabled"
    await expect(page.getByText('Enabled').first()).toBeVisible({ timeout: 8_000 });
    // Stats returned non-ok → both Indexed records and Total chunks show "—"
    const dashCells = page.getByText('—', { exact: true });
    await expect(dashCells).toHaveCount(2, { timeout: 8_000 });
  });
});
