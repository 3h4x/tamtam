import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';

// Settings → Templates tab e2e UI tests.
//
// AgentTemplatesTab is a purely local-state component — it reads `agent_templates`
// (JSON string) from settings on load and emits updated JSON strings via onChange,
// which the settings shell PATCH-es back on "Save". These tests exercise:
//   1. Empty state renders correctly with no templates.
//   2. Clicking "+ Add Template" opens the creation form.
//   3. The "Add Template" submit button is disabled when the name field is blank.
//   4. Filling name + saving adds the template card to the list.
//   5. Deleting the only template restores the empty state.
//
// All API calls are mocked — no pipeline execution.

const TEMPLATE_A = {
  name: 'security-review',
  description: 'Automated security scan',
  model: 'normal',
  schedule: '24h',
  prompt: 'Run a security audit on the codebase.',
};

function makeSettings(overrides: Record<string, string> = {}) {
  return {
    workspace_path: '',
    github_owner: '',
    jobs_paused: 'false',
    agent_templates: '',
    ...overrides,
  };
}

async function stubShell(
  page: import('@playwright/test').Page,
  settingsOverrides: Record<string, string> = {},
): Promise<void> {
  let current = makeSettings(settingsOverrides);

  await page.route('**/api/settings', async (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { settings: current } });
    }
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, string>;
      current = { ...current, ...body };
      return route.fulfill({ json: { settings: current } });
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

test.describe('Settings → Templates tab', () => {
  test('empty state shows "No custom templates yet" with no templates', async ({ page }) => {
    await stubShell(page);
    await page.goto('/settings/templates');

    await expect(page.getByRole('heading', { name: 'Agent Templates' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No custom templates yet')).toBeVisible({ timeout: 5_000 });
  });

  test('clicking "+ Add Template" opens the creation form', async ({ page }) => {
    await stubShell(page);
    await page.goto('/settings/templates');

    await expect(page.getByRole('heading', { name: 'Agent Templates' })).toBeVisible({
      timeout: 8_000,
    });

    await page.getByRole('button', { name: '+ Add Template' }).click();

    // Form fields should appear.
    await expect(page.getByPlaceholder('e.g. security-review')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByPlaceholder('What should this agent do when it runs?')).toBeVisible({
      timeout: 5_000,
    });
  });

  test('"Add Template" submit is disabled when name is blank', async ({ page }) => {
    await stubShell(page);
    await page.goto('/settings/templates');

    await expect(page.getByRole('heading', { name: 'Agent Templates' })).toBeVisible({
      timeout: 8_000,
    });

    await page.getByRole('button', { name: '+ Add Template' }).click();
    await expect(page.getByPlaceholder('e.g. security-review')).toBeVisible({ timeout: 5_000 });

    // The submit button inside the form has text "Add Template" and should be disabled.
    const submitBtn = page.getByRole('button', { name: 'Add Template' }).last();
    await expect(submitBtn).toBeDisabled();
  });

  test('adding a template saves and shows it in the list', async ({ page }) => {
    await stubShell(page);
    await page.goto('/settings/templates');

    await expect(page.getByRole('heading', { name: 'Agent Templates' })).toBeVisible({
      timeout: 8_000,
    });

    await page.getByRole('button', { name: '+ Add Template' }).click();
    await page.getByPlaceholder('e.g. security-review').fill(TEMPLATE_A.name);
    await page.getByPlaceholder('Short description shown in the list').fill(TEMPLATE_A.description);
    await page.getByPlaceholder('What should this agent do when it runs?').fill(TEMPLATE_A.prompt);

    const submitBtn = page.getByRole('button', { name: 'Add Template' }).last();
    await expect(submitBtn).toBeEnabled({ timeout: 3_000 });
    await submitBtn.click();

    // Template card appears with the given name.
    await expect(page.getByText(TEMPLATE_A.name)).toBeVisible({ timeout: 5_000 });
    // Description is shown on the card.
    await expect(page.getByText(TEMPLATE_A.description)).toBeVisible({ timeout: 5_000 });
    // The form is gone and the header "+ Add Template" button is back.
    await expect(page.getByRole('button', { name: '+ Add Template' })).toBeVisible({
      timeout: 5_000,
    });
    // Empty state no longer visible.
    await expect(page.getByText('No custom templates yet')).toHaveCount(0);
  });

  test('deleting the only template restores the empty state', async ({ page }) => {
    // Pre-seed a template so the tab loads with one entry.
    await stubShell(page, { agent_templates: JSON.stringify([TEMPLATE_A]) });
    await page.goto('/settings/templates');

    await expect(page.getByRole('heading', { name: 'Agent Templates' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(TEMPLATE_A.name)).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: 'Delete' }).click();

    // Empty state returns.
    await expect(page.getByText('No custom templates yet')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(TEMPLATE_A.name)).toHaveCount(0);
  });

  test('editing a template updates the card', async ({ page }) => {
    await stubShell(page, { agent_templates: JSON.stringify([TEMPLATE_A]) });
    await page.goto('/settings/templates');

    await expect(page.getByText(TEMPLATE_A.name)).toBeVisible({ timeout: 8_000 });

    await page.getByRole('button', { name: 'Edit' }).click();
    // Name field should be pre-filled.
    const nameInput = page.getByPlaceholder('e.g. security-review');
    await expect(nameInput).toHaveValue(TEMPLATE_A.name, { timeout: 3_000 });

    // Change the name.
    await nameInput.fill('updated-review');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // Updated name is shown; old name is gone.
    await expect(page.getByText('updated-review')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(TEMPLATE_A.name)).toHaveCount(0);
  });
});
