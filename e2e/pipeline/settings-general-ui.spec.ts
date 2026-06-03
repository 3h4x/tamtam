import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// UI tests for the Settings → General page save flow:
// load defaults → dirty detection → "Unsaved changes" → Save/Saving…/Saved! → error state.
// All API calls are mocked via page.route(); no pipeline execution needed.
//
// SettingsField renders labels without htmlFor/id associations, so selectors use
// getByPlaceholder (from the `Enter ${label.toLowerCase()}` fallback) rather than
// getByRole/getByLabel.

function makeSettings(overrides: Record<string, string> = {}) {
  return {
    workspace_path: '/home/user/projects',
    github_owner: '',
    trusted_github_users: '',
    claude_provider: 'claude',
    claude_bin: '~/.local/bin/claude',
    log_dir: '',
    frequency: '0',
    daytime: 'false',
    weekends: 'false',
    base_prompt: '',
    default_model: '',
    permission_mode: 'auto',
    commit_style: '',
    review_verdict_rules: '',
    fix_max_iterations: '0',
    review_fix_backoff_seconds: '0',
    review_do_not_ship_action: 'fix',
    release_wall_clock_timeout_minutes: '60',
    log_retention_count: '200',
    log_retention_days: '30',
    job_row_retention_days: '180',
    workflow_run_retention_days: '30',
    jobs_paused: 'false',
    retrieval_enabled: 'false',
    orchestrator_enabled: 'false',
    orchestrator_boost_margin_pct: '10',
    orchestrator_max_boosts_per_hour: '3',
    project_sweep_enabled: 'false',
    incremental_review_enabled: 'false',
    browser_broker_enabled: 'false',
    browser_broker_image: '',
    tamtam_network_policy_strict: 'false',
    legacy_completion_hook_release_after_run_enabled: 'false',
    legacy_completion_hook_release_after_fix_ci_enabled: 'false',
    legacy_completion_hook_auto_resume_enabled: 'false',
    legacy_pipeline_lock_inline_drain_enabled: 'false',
    legacy_completion_hook_agent_drain_enabled: 'false',
    plain_test_phase_enabled: 'false',
    notification_webhook_url: '',
    notification_webhook_secret: '',
    notification_on_release_success: 'false',
    notification_on_release_fail: 'false',
    notification_on_release_aborted: 'false',
    notification_on_fix_loop_exhausted: 'false',
    notification_on_review_do_not_ship: 'false',
    notification_on_agent_run_fail: 'false',
    notification_throttle_window_seconds: '60',
    notification_throttle_overrides: '',
    pipeline_model_review: '',
    pipeline_model_fix: '',
    pipeline_model_dod: '',
    pipeline_model_commit: '',
    dirty_worktree_block_threshold: '0',
    lmstudio_model: '',
    ...overrides,
  };
}

async function stubApis(
  page: import('@playwright/test').Page,
  settingsOverrides: Record<string, string> = {},
) {
  let currentSettings = makeSettings(settingsOverrides);

  await page.route('**/api/settings', async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { settings: currentSettings } });
      return;
    }
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, string>;
      currentSettings = { ...currentSettings, ...body };
      await route.fulfill({ json: { settings: currentSettings } });
      return;
    }
    route.continue();
  });

  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { notifications: [] } }),
  );
  await page.route('**/api/agents**', (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
}

// GitHub Owner field placeholder: DEFAULTS['github_owner'] is '' → fallback 'Enter github owner'
function githubOwnerField(page: import('@playwright/test').Page) {
  return page.getByPlaceholder('Enter github owner');
}

test.describe('Settings general page save flow', () => {
  // ---------------------------------------------------------------------------
  // Test 1: Page loads and Save Settings is initially disabled
  // ---------------------------------------------------------------------------
  test('Save Settings button is disabled when no changes are made', async ({ page }) => {
    await stubApis(page);
    await page.goto('/settings/general');

    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeDisabled();
    await expect(page.getByText('Unsaved changes')).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Editing GitHub Owner marks the form dirty
  // ---------------------------------------------------------------------------
  test('editing GitHub Owner shows Unsaved changes and enables Save', async ({ page }) => {
    await stubApis(page);
    await page.goto('/settings/general');

    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible({ timeout: 10_000 });
    await expect(githubOwnerField(page)).toBeVisible({ timeout: 8_000 });

    await githubOwnerField(page).fill('my-org');

    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeEnabled();
  });

  // ---------------------------------------------------------------------------
  // Test 3: Successful save shows Saved! then returns to disabled
  // ---------------------------------------------------------------------------
  test('clicking Save Settings shows Saved! then returns to disabled state', async ({ page }) => {
    let savedGithubOwner = '';
    let patchCount = 0;

    await page.route('**/api/settings', async (route: Route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { settings: makeSettings({ github_owner: savedGithubOwner }) } });
        return;
      }
      if (route.request().method() === 'PATCH') {
        patchCount += 1;
        const body = route.request().postDataJSON() as Record<string, string>;
        if (body.github_owner !== undefined) savedGithubOwner = body.github_owner;
        await page.getByRole('button', { name: /Saving/i }).waitFor({ state: 'visible' });
        await route.fulfill({ json: { settings: makeSettings({ github_owner: savedGithubOwner }) } });
        return;
      }
      route.continue();
    });
    await page.route('**/api/projects', (route: Route) =>
      route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
    );
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({ json: { notifications: [] } }),
    );
    await page.route('**/api/agents**', (route: Route) =>
      route.fulfill({ json: { agents: [] } }),
    );

    await page.goto('/settings/general');
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible({ timeout: 10_000 });
    await expect(githubOwnerField(page)).toBeVisible({ timeout: 8_000 });

    await githubOwnerField(page).fill('my-org');
    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });

    await page.getByRole('button', { name: 'Save Settings' }).click();

    // Saving… state
    await expect(page.getByRole('button', { name: /Saving/i })).toBeVisible({ timeout: 3_000 });

    // Saved! state
    await expect(page.getByRole('button', { name: 'Saved!' })).toBeVisible({ timeout: 5_000 });

    // Returns to clean disabled state after the brief confirmation window
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeDisabled({ timeout: 5_000 });
    await expect(page.getByText('Unsaved changes')).not.toBeVisible({ timeout: 3_000 });

    expect(patchCount).toBe(1);
    expect(savedGithubOwner).toBe('my-org');
  });

  // ---------------------------------------------------------------------------
  // Test 4: Failed save shows error and re-enables the Save button
  // ---------------------------------------------------------------------------
  test('a failed PATCH shows an error and re-enables Save Settings', async ({ page }) => {
    await page.route('**/api/settings', async (route: Route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { settings: makeSettings() } });
        return;
      }
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 500, json: { error: 'disk full' } });
        return;
      }
      route.continue();
    });
    await page.route('**/api/projects', (route: Route) =>
      route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
    );
    await page.route('**/api/jobs/notifications', (route: Route) =>
      route.fulfill({ json: { notifications: [] } }),
    );
    await page.route('**/api/agents**', (route: Route) =>
      route.fulfill({ json: { agents: [] } }),
    );

    await page.goto('/settings/general');
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible({ timeout: 10_000 });
    await expect(githubOwnerField(page)).toBeVisible({ timeout: 8_000 });

    await githubOwnerField(page).fill('broken-org');
    await page.getByRole('button', { name: 'Save Settings' }).click();

    // Error message should surface (component prepends "Failed to save:" then uses data.detail || statusText)
    await expect(
      page.getByText(/failed to save/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    // Save button must return to enabled (not stuck in saving state)
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeEnabled({ timeout: 3_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 5: Tab navigation — clicking Pipeline navigates to /settings/pipeline
  // ---------------------------------------------------------------------------
  test('clicking the Pipeline tab navigates to /settings/pipeline', async ({ page }) => {
    await stubApis(page);
    await page.goto('/settings/general');

    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible({ timeout: 10_000 });

    const settingsNav = page.getByRole('navigation', { name: 'Settings navigation' });
    const pipelineNavItem = settingsNav.getByRole('button', { name: 'Pipeline' });
    await expect(pipelineNavItem).toBeVisible({ timeout: 5_000 });
    await pipelineNavItem.click();

    await expect(page).toHaveURL(/\/settings\/pipeline/, { timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // Test 6: Reverting a change to its original value clears dirty state
  // ---------------------------------------------------------------------------
  test('reverting a field back to its original value clears dirty state', async ({ page }) => {
    await stubApis(page, { github_owner: 'original-org' });
    await page.goto('/settings/general');

    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible({ timeout: 10_000 });

    // github_owner now has value 'original-org', placeholder is still 'Enter github owner'
    // but the field value matches; locate via placeholder
    const ownerField = githubOwnerField(page);
    await expect(ownerField).toBeVisible({ timeout: 8_000 });

    // Make it dirty
    await ownerField.fill('new-org');
    await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 3_000 });

    // Revert to original
    await ownerField.fill('original-org');
    await expect(page.getByText('Unsaved changes')).not.toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeDisabled();
  });
});
