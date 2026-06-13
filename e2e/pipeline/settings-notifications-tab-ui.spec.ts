import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Settings → Notifications tab e2e UI tests.
//
// The unit tests (notifications-tab.test.tsx) cover internal state using fake
// timers and stubbed fetch. These tests fill the gaps they leave:
//   1. "Send Test" button disabled when no webhook URL is configured.
//   2. The "Sending…" intermediate state while a request is in-flight.
//   3. The error text shown when the test-notification endpoint returns an error.
//
// All API calls are mocked — no real pipeline execution and no real webhook.

function makeSettings(overrides: Record<string, string> = {}) {
  return {
    workspace_path: '',
    github_owner: '',
    jobs_paused: 'false',
    notification_webhook_url: '',
    notification_webhook_secret: '',
    notification_on_release_success: 'false',
    notification_on_release_fail: 'false',
    notification_on_release_aborted: 'false',
    notification_on_fix_loop_exhausted: 'false',
    notification_on_review_do_not_ship: 'false',
    notification_on_agent_run_fail: 'false',
    notification_on_budget_blocked: 'false',
    notification_throttle_window_seconds: '900',
    notification_throttle_overrides: '',
    ...overrides,
  };
}

async function stubShell(
  page: import('@playwright/test').Page,
  overrides: Record<string, string> = {},
): Promise<void> {
  await page.route('**/api/settings', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { settings: makeSettings(overrides) } });
    }
    return route.continue();
  });
  await page.route('**/api/projects', (route: Route) =>
    route.fulfill({ json: { tasks: [], priorities: [], issueCounts: {} } }),
  );
  await page.route('**/api/jobs/notifications', (route: Route) =>
    route.fulfill({ json: { count: 0, jobs: [], runningCount: 0, runningJobs: [] } }),
  );
  await page.route('**/api/agents**', (route: Route) =>
    route.fulfill({ json: { agents: [] } }),
  );
}

test.describe('Settings → Notifications tab', () => {
  test('"Send Test" button is disabled when no webhook URL is configured', async ({ page }) => {
    await stubShell(page);
    await page.goto('/settings/notifications');

    await expect(page.getByRole('heading', { name: 'Webhook Configuration' })).toBeVisible({
      timeout: 8_000,
    });
    const btn = page.getByRole('button', { name: 'Send Test' });
    await expect(btn).toBeVisible({ timeout: 8_000 });
    await expect(btn).toBeDisabled();
  });

  test('"Send Test" shows "Sending…" while in-flight then "Sent!" on success', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await stubShell(page, { notification_webhook_url: 'https://hooks.example.com/test' });
    await page.route('**/api/settings/test-notification', async (route: Route) => {
      await gate;
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto('/settings/notifications');
    await expect(page.getByRole('heading', { name: 'Webhook Configuration' })).toBeVisible({
      timeout: 8_000,
    });

    const sendBtn = page.getByRole('button', { name: 'Send Test' });
    await expect(sendBtn).toBeEnabled({ timeout: 8_000 });
    await sendBtn.click();

    // While the request is in-flight the button shows "Sending…" and is disabled.
    const sendingBtn = page.getByRole('button', { name: 'Sending…' });
    await expect(sendingBtn).toBeVisible({ timeout: 5_000 });
    await expect(sendingBtn).toBeDisabled();

    // Release the gate — the response resolves successfully.
    release();

    // Button briefly shows "Sent!" and no error callout is visible.
    await expect(page.getByRole('button', { name: 'Sent!' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Failed to send/i)).toHaveCount(0);
  });

  test('"Send Test" shows the server error message and re-enables the button on failure', async ({
    page,
  }) => {
    await stubShell(page, { notification_webhook_url: 'https://hooks.example.com/test' });
    await page.route('**/api/settings/test-notification', (route: Route) =>
      route.fulfill({
        status: 502,
        json: { ok: false, error: 'upstream webhook returned 502 Bad Gateway' },
      }),
    );

    await page.goto('/settings/notifications');
    await expect(page.getByRole('heading', { name: 'Webhook Configuration' })).toBeVisible({
      timeout: 8_000,
    });

    const sendBtn = page.getByRole('button', { name: 'Send Test' });
    await expect(sendBtn).toBeEnabled({ timeout: 8_000 });
    await sendBtn.click();

    // The server error detail surfaces inline.
    await expect(
      page.getByText('upstream webhook returned 502 Bad Gateway'),
    ).toBeVisible({ timeout: 5_000 });

    // Button re-enables so the user can retry after fixing the webhook URL.
    await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Sending…' })).toHaveCount(0);
  });
});
