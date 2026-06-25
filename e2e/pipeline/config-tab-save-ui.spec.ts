import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// UI tests for the ConfigTab save flow:
// dirty detection → Unsaved changes banner → Save/Saving…/Saved! states → error toast.
// All API calls are mocked via page.route(); no real pipeline execution needed.

const PROJECT = 'config-tab-save-ui';

function websiteField(page: Page) {
  return page.getByRole('textbox', { name: 'Website', exact: true });
}

function watchMinutesField(page: Page) {
  return page.getByRole('spinbutton', { name: 'Watch minutes' });
}

function waitForCiCheckbox(page: Page) {
  return page.getByRole('checkbox', { name: /Wait for CI on default branch after merge/i });
}

function devServerStartField(page: Page) {
  return page.getByRole('textbox', { name: 'Start command' });
}

function devServerReadyUrlField(page: Page) {
  return page.getByRole('textbox', { name: 'Ready URL' });
}

function devServerStopField(page: Page) {
  return page.getByRole('textbox', { name: 'Stop command' });
}

function autoRevertCheckbox(page: Page) {
  return page.getByRole('checkbox', { name: /Auto-merge revert PR/i });
}

function makeTask() {
  return {
    id: `${PROJECT}-1`,
    project: PROJECT,
    job: null,
    priority: null,
    path: `/tmp/${PROJECT}`,
    fires_at: '',
    sync: true,
    changes: 3,
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

function makeProjectConfig(overrides: Record<string, unknown> = {}) {
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
    dev_server_start_command: '',
    dev_server_stop_command: '',
    dev_server_ready_url: '',
    file_config: [],
    file_config_branch: 'master',
    file_config_is_default_branch: true,
    current_branch: 'master',
    paused: false,
    last_push_error: null,
    last_push_at: null,
    ...overrides,
  };
}

async function stubShell(
  page: Page,
  opts: { settings?: () => { settings: Record<string, string>; github_owner?: string } } = {},
): Promise<void> {
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({
      json: { tasks: [makeTask()], priorities: [], issueCounts: {} },
    }),
  );
  await page.route('**/api/settings', (route: Route) => {
    if (route.request().method() !== 'GET') {
      route.continue();
      return;
    }
    route.fulfill({
      json: opts.settings
        ? opts.settings()
        : { settings: { jobs_paused: 'false', retrieval_enabled: 'false' } },
    });
  });
  await page.route(
    `**/api/projects/by-project/${PROJECT}/config`,
    (route: Route) => {
      if (route.request().method() !== 'GET') {
        route.continue();
        return;
      }
      route.fulfill({ json: makeProjectConfig() });
    },
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
  await page.route(`**/api/agents**`, (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route('**/api/streaming/**', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  // Retrieval panel (rendered on config tab)
  await page.route(`**/api/projects/${PROJECT}/retrieval/stats`, (route: Route) =>
    route.fulfill({ json: { records: 0, chunks: 0 } }),
  );
}

test.describe('ConfigTab save flow', () => {
  // ---------------------------------------------------------------------------
  // Test 1: Save button starts disabled when nothing is dirty
  // ---------------------------------------------------------------------------
  test('Save button is disabled when config matches server values', async ({ page }) => {
    await stubShell(page);
    await page.goto(`/project/${PROJECT}/config`);

    // Wait for config to load (website field becomes visible)
    await expect(websiteField(page)).toBeVisible({ timeout: 8_000 });

    const saveBtn = page.getByRole('button', { name: /^Save$/ });
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toBeDisabled();
    await expect(page.getByText('Unsaved changes')).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Editing the website field marks the form dirty
  // ---------------------------------------------------------------------------
  test('editing the website field shows Unsaved changes and enables Save', async ({ page }) => {
    await stubShell(page);
    await page.goto(`/project/${PROJECT}/config`);

    await expect(websiteField(page)).toBeVisible({ timeout: 8_000 });

    await websiteField(page).fill('https://example.com');

    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });
    const saveBtn = page.getByRole('button', { name: /^Save$/ });
    await expect(saveBtn).toBeEnabled();
  });

  // ---------------------------------------------------------------------------
  // Test 3: Successful save cycle — Saving… → clean disabled Save
  // ---------------------------------------------------------------------------
  test('clicking Save shows Saving then clears dirty state after successful PATCH', async ({ page }) => {
    let patchBody: Record<string, unknown> | null = null;
    let patchCallCount = 0;
    let serverConfig = makeProjectConfig();

    await stubShell(page);

    // Intercept PATCH with a slight delay to catch the Saving… state.
    await page.route(`**/api/projects/by-project/${PROJECT}/config`, async (route: Route) => {
      if (route.request().method() === 'PATCH') {
        patchCallCount += 1;
        patchBody = route.request().postDataJSON() as Record<string, unknown>;
        serverConfig = makeProjectConfig({ website: patchBody.website });
        await new Promise((r) => setTimeout(r, 50));
        await route.fulfill({ json: { status: 'ok' } });
        return;
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: serverConfig });
        return;
      }
      route.continue();
    });

    await page.goto(`/project/${PROJECT}/config`);
    await expect(websiteField(page)).toBeVisible({ timeout: 8_000 });

    await websiteField(page).fill('https://example.com');
    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });

    const saveBtn = page.getByRole('button', { name: /^Save$/ });
    await saveBtn.click();

    // Button should briefly show Saving…
    await expect(page.getByRole('button', { name: /Saving/i })).toBeVisible({ timeout: 3_000 });

    // Then transition back to a clean, disabled Save button.
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeDisabled({ timeout: 5_000 });
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 5_000 });

    // Verify the PATCH was called and included the website value.
    expect(patchCallCount).toBe(1);
    expect((patchBody as Record<string, unknown> | null)?.website).toBe('https://example.com');
  });

  test('soak settings render from config and save updated minutes + auto-revert', async ({ page }) => {
    let savedWatchMinutes: unknown = null;
    let savedAutoRevert: unknown = null;
    let serverConfig = makeProjectConfig({
      post_merge_watch_minutes: 15,
      auto_revert_enabled: false,
    });

    await stubShell(page);

    await page.route(`**/api/projects/by-project/${PROJECT}/config`, async (route: Route) => {
      if (route.request().method() === 'PATCH') {
        const patchBody = route.request().postDataJSON() as Record<string, unknown>;
        savedWatchMinutes = patchBody.post_merge_watch_minutes;
        savedAutoRevert = patchBody.auto_revert_enabled;
        serverConfig = makeProjectConfig({
          post_merge_watch_minutes: patchBody.post_merge_watch_minutes,
          auto_revert_enabled: patchBody.auto_revert_enabled,
        });
        await route.fulfill({ json: { status: 'ok' } });
        return;
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: serverConfig });
        return;
      }
      route.continue();
    });

    await page.goto(`/project/${PROJECT}/config`);

    await expect(waitForCiCheckbox(page)).toBeChecked({ timeout: 8_000 });
    await expect(watchMinutesField(page)).toHaveValue('15');
    await expect(autoRevertCheckbox(page)).not.toBeChecked();

    await watchMinutesField(page).fill('30');
    await autoRevertCheckbox(page).check();
    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });

    await page.getByRole('button', { name: /^Save$/ }).click();

    await expect(page.getByRole('button', { name: /^Save$/ })).toBeDisabled({ timeout: 5_000 });
    expect(savedWatchMinutes).toBe('30');
    expect(savedAutoRevert).toBe(true);

    await expect(waitForCiCheckbox(page)).toBeChecked();
    await expect(watchMinutesField(page)).toHaveValue('30');
    await expect(autoRevertCheckbox(page)).toBeChecked();
  });

  test('dev server lifecycle fields render from config and save updated values', async ({ page }) => {
    let savedBody: Record<string, unknown> | null = null;
    let finishPatch!: () => void;
    const patchGate = new Promise<void>((resolve) => {
      finishPatch = resolve;
    });
    let serverConfig = makeProjectConfig({
      dev_server_start_command: 'pnpm dev --port 3000',
      dev_server_ready_url: 'http://localhost:3000',
      dev_server_stop_command: 'pnpm dev:stop',
    });

    await stubShell(page);

    await page.route(`**/api/projects/by-project/${PROJECT}/config`, async (route: Route) => {
      if (route.request().method() === 'PATCH') {
        savedBody = route.request().postDataJSON() as Record<string, unknown>;
        serverConfig = makeProjectConfig({
          dev_server_start_command: savedBody.dev_server_start_command,
          dev_server_ready_url: savedBody.dev_server_ready_url,
          dev_server_stop_command: savedBody.dev_server_stop_command,
        });
        await patchGate;
        await route.fulfill({ json: { status: 'ok' } });
        return;
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: serverConfig });
        return;
      }
      route.continue();
    });

    await page.goto(`/project/${PROJECT}/config`);

    await expect(devServerStartField(page)).toHaveValue('pnpm dev --port 3000', { timeout: 8_000 });
    await expect(devServerReadyUrlField(page)).toHaveValue('http://localhost:3000');
    await expect(devServerStopField(page)).toHaveValue('pnpm dev:stop');

    await devServerStartField(page).fill('pnpm dev --port 4173');
    await devServerReadyUrlField(page).fill('http://127.0.0.1:4173/health');
    await devServerStopField(page).fill('pnpm dev:stop --force');
    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });

    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByRole('button', { name: /Saving/i })).toBeVisible({ timeout: 3_000 });

    expect(savedBody).toMatchObject({
      dev_server_start_command: 'pnpm dev --port 4173',
      dev_server_ready_url: 'http://127.0.0.1:4173/health',
      dev_server_stop_command: 'pnpm dev:stop --force',
    });

    finishPatch();

    await expect(page.getByRole('button', { name: /^Save$/ })).toBeDisabled({ timeout: 5_000 });
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 5_000 });
    await expect(devServerStartField(page)).toHaveValue('pnpm dev --port 4173');
    await expect(devServerReadyUrlField(page)).toHaveValue('http://127.0.0.1:4173/health');
    await expect(devServerStopField(page)).toHaveValue('pnpm dev:stop --force');
  });

  // ---------------------------------------------------------------------------
  // Failed save shows error toast
  // ---------------------------------------------------------------------------
  test('a failed PATCH shows an error toast', async ({ page }) => {
    await stubShell(page);

    await page.route(`**/api/projects/by-project/${PROJECT}/config`, async (route: Route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          json: { detail: 'internal server error' },
        });
        return;
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: makeProjectConfig() });
        return;
      }
      route.continue();
    });

    await page.goto(`/project/${PROJECT}/config`);
    await expect(websiteField(page)).toBeVisible({ timeout: 8_000 });

    await websiteField(page).fill('https://broken.example.com');
    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });

    await page.getByRole('button', { name: /^Save$/ }).click();

    // An error toast should appear (the client surfaces the server detail).
    await expect(page.getByText(/internal server error|failed to update config/i).first()).toBeVisible({ timeout: 5_000 });
    // Save button must return to enabled (not stuck in saving state).
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeEnabled({ timeout: 3_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 5: Clearing a dirty field back to its original value removes dirty state
  // ---------------------------------------------------------------------------
  test('reverting a change to original value clears dirty state', async ({ page }) => {
    await stubShell(page);
    await page.goto(`/project/${PROJECT}/config`);

    await expect(websiteField(page)).toBeVisible({ timeout: 8_000 });

    // Make it dirty.
    await websiteField(page).fill('https://example.com');
    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });

    // Revert to original (empty).
    await websiteField(page).fill('');
    await expect(page.getByText('Unsaved changes')).not.toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // Test 6: Cron schedule toggle shows/hides the interval input and marks dirty
  // ---------------------------------------------------------------------------
  test('enabling Run on schedule reveals interval input and marks form dirty', async ({ page }) => {
    await stubShell(page);
    await page.goto(`/project/${PROJECT}/config`);

    await expect(websiteField(page)).toBeVisible({ timeout: 8_000 });

    // Interval input should not exist while cron is disabled.
    await expect(page.getByLabel('Schedule interval')).not.toBeVisible();

    // Find and click the "Run on schedule" checkbox.
    const cronToggle = page.getByRole('checkbox', { name: /run on schedule/i });
    await expect(cronToggle).toBeVisible({ timeout: 5_000 });
    await cronToggle.click();

    // Interval input should now be visible.
    await expect(page.getByLabel('Schedule interval')).toBeVisible({ timeout: 3_000 });

    // Form should be dirty.
    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeEnabled();
  });

  // ---------------------------------------------------------------------------
  // Test 7: Typing a schedule interval marks the form dirty
  // ---------------------------------------------------------------------------
  test('typing a schedule interval marks the form dirty', async ({ page }) => {
    await stubShell(page);
    // Start with cron enabled so the interval input is immediately visible.
    await page.route(
      `**/api/projects/by-project/${PROJECT}/config`,
      (route: Route) => {
        if (route.request().method() !== 'GET') { route.continue(); return; }
        route.fulfill({ json: makeProjectConfig({ test_cron_enabled: true, test_cron_schedule: '1h' }) });
      },
    );

    await page.goto(`/project/${PROJECT}/config`);
    await expect(page.getByLabel('Schedule interval')).toBeVisible({ timeout: 8_000 });

    await page.getByLabel('Schedule interval').fill('30m');

    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeEnabled();
  });

  test('jobs_paused transition disables and restores Release on config tab', async ({ page }) => {
    let jobsPaused = true;

    await stubShell(page, {
      settings: () => ({
        settings: {
          jobs_paused: jobsPaused ? 'true' : 'false',
          retrieval_enabled: 'false',
        },
        github_owner: '',
      }),
    });

    await page.goto(`/project/${PROJECT}/config`);

    const stableUrl = page.url();
    const releaseButton = page.getByRole('button', { name: 'Release', exact: true });
    const pauseSwitch = page.getByRole('switch');

    await expect(websiteField(page)).toBeVisible({ timeout: 8_000 });
    await expect(releaseButton).toBeDisabled();
    await expect(releaseButton).toHaveAttribute('title', /jobs are paused globally/i);
    await expect(pauseSwitch).toHaveText('jobs paused');
    await expect(pauseSwitch).toBeChecked();

    jobsPaused = false;

    await expect(releaseButton).toBeEnabled({ timeout: 12_000 });
    await expect(releaseButton).toHaveAttribute('title', /Release: review/i);
    await expect(pauseSwitch).toHaveText('jobs running', { timeout: 12_000 });
    await expect(pauseSwitch).not.toBeChecked();
    await expect(page).toHaveURL(stableUrl);
  });

  // ---------------------------------------------------------------------------
  // Config load failure shows ErrorState with a working Retry
  // ---------------------------------------------------------------------------
  test('a failed config load shows Retry, and retrying recovers the form', async ({ page }) => {
    const configPattern = `**/api/projects/by-project/${PROJECT}/config`;

    await stubShell(page);

    // Persistently fail the config GET so the error state is deterministic even
    // under React StrictMode's double-invoked mount effect in dev.
    await page.route(configPattern, async (route: Route) => {
      if (route.request().method() !== 'GET') {
        route.continue();
        return;
      }
      await route.fulfill({ status: 500, json: { detail: 'config unavailable' } });
    });

    await page.goto(`/project/${PROJECT}/config`);

    // The error state should render with a Retry button; the form is absent.
    await expect(page.getByText('Failed to load configuration')).toBeVisible({ timeout: 8_000 });
    const retryBtn = page.getByRole('button', { name: /^Retry$/ });
    await expect(retryBtn).toBeVisible();
    await expect(websiteField(page)).not.toBeVisible();

    // Recover the endpoint, then retry: the refetch should populate the form.
    await page.unroute(configPattern);
    let retriedGet = false;
    await page.route(configPattern, async (route: Route) => {
      if (route.request().method() !== 'GET') {
        route.continue();
        return;
      }
      retriedGet = true;
      await route.fulfill({ json: makeProjectConfig() });
    });

    await retryBtn.click();

    await expect(websiteField(page)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Failed to load configuration')).not.toBeVisible();
    expect(retriedGet).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Pipeline step toggle (clicking "review" chip) marks form dirty
  // ---------------------------------------------------------------------------
  test('toggling the review pipeline step marks the form dirty', async ({ page }) => {
    await stubShell(page);
    await page.goto(`/project/${PROJECT}/config`);

    await expect(websiteField(page)).toBeVisible({ timeout: 8_000 });

    // The review chip should be active (review_disabled=false in config).
    // Clicking it will set review_disabled=true → dirty.
    const reviewChip = page.getByRole('button', { name: /^review$/ });
    await expect(reviewChip).toBeVisible({ timeout: 5_000 });
    await reviewChip.click();

    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeEnabled();
  });
});
