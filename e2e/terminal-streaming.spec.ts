import { test, expect } from '@playwright/test';

test.describe('Terminal page streaming', () => {
  test('page loads with prompt input and run button', async ({ page }) => {
    await page.goto('/project/tamtam/terminal');
    await expect(page.getByRole('textbox', { name: 'What should Claude do?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run' }).last()).toBeVisible();
  });

  test('model selector defaults to haiku', async ({ page }) => {
    await page.goto('/project/tamtam/terminal');
    const select = page.locator('select');
    await expect(select).toHaveValue('haiku');
  });

  test('model selector has all options', async ({ page }) => {
    await page.goto('/project/tamtam/terminal');
    const options = page.locator('select option');
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveText('Haiku');
    await expect(options.nth(1)).toHaveText('Sonnet');
    await expect(options.nth(2)).toHaveText('Opus');
  });

  test('skill picker opens and shows search', async ({ page }) => {
    await page.goto('/project/tamtam/terminal');
    await page.getByRole('button', { name: '+ Skill' }).click();
    await expect(page.getByPlaceholder('Search skills...')).toBeVisible();
  });

  test('run produces streaming output and completes', async ({ page }) => {
    await page.goto('/project/tamtam/terminal');
    const textarea = page.getByRole('textbox', { name: 'What should Claude do?' });
    await textarea.fill('say hello in exactly 3 words');

    // Click the Run button in the prompt area (the last one on the page)
    await page.getByRole('button', { name: 'Run' }).last().click();

    // Wait for output to appear (not stuck on "Waiting for output...")
    const pre = page.locator('pre');
    await expect(pre).toBeVisible({ timeout: 30_000 });
    await expect(pre).not.toHaveText('Waiting for output...', { timeout: 30_000 });

    // Verify output has actual text content
    const output = await pre.textContent();
    expect(output).toBeTruthy();
    expect(output!.length).toBeGreaterThan(0);

    // Wait for completion — dismiss button only appears when done
    await expect(page.getByTitle('Dismiss')).toBeVisible({ timeout: 30_000 });

    // Click dismiss — session should be removed
    await page.getByTitle('Dismiss').click();
    await expect(pre).not.toBeVisible();
  });
});
