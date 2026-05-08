import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  enableProject,
  waitForJobRunning,
  waitForPipelineCompletion,
} from './helpers';

const SUCCESS_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);

const HISTORY_PROJECT = 'queued-release-history';
const TERMINAL_PROJECT = 'queued-release-terminal';

test.describe('Queued release recovery after resuming jobs', () => {
  test.afterEach(async ({ request }) => {
    await request.patch('/api/settings', { data: { jobs_paused: false } });
  });

  test('history tab shows a queued release banner while paused, then starts and clears after resume without reload', async ({
    page,
    request,
  }) => {
    writeScenario(HISTORY_PROJECT, SUCCESS_SCENARIO.steps);
    resetShimState(HISTORY_PROJECT);
    await enableProject(request, HISTORY_PROJECT, { testsDisabled: true });
    await request.patch('/api/settings', { data: { jobs_paused: true } });

    await page.goto(`/project/${HISTORY_PROJECT}/history`);

    const releaseButton = page.getByRole('button', { name: /release/i }).first();
    await expect(releaseButton).toBeVisible({ timeout: 8_000 });
    await expect(releaseButton).toBeDisabled();
    await expect(releaseButton).toHaveAttribute('title', /jobs are paused globally/i);

    const queuedResp = await request.post(`/api/projects/by-project/${HISTORY_PROJECT}/release`, {
      data: { queue_if_blocked: true },
    });
    expect(
      queuedResp.status(),
      `queued release POST failed: ${await queuedResp.text()}`,
    ).toBe(202);

    await expect(
      page.getByText(/Release queued — will fire automatically/i),
    ).toBeVisible({ timeout: 12_000 });

    const pauseToggle = page.getByRole('switch', { name: /jobs paused/i });
    await expect(pauseToggle).toHaveAttribute('aria-checked', 'true');
    await pauseToggle.click();

    const runningRelease = await waitForJobRunning(request, HISTORY_PROJECT, 'release', 20_000);
    expect(runningRelease, 'queued release should start after resuming jobs').not.toBeNull();

    await expect(
      page.getByText(/Release queued — will fire automatically/i),
    ).not.toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 12_000 });

    const result = await waitForPipelineCompletion(request, HISTORY_PROJECT, 90_000);
    expect(result.status, 'queued release should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'queued release exit code').toBe(0);

    await expect(page.getByText('done').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });
  });

  test('terminal landing page stays idle while paused, then auto-attaches to the queued release after resume', async ({
    page,
    request,
  }) => {
    writeScenario(TERMINAL_PROJECT, SUCCESS_SCENARIO.steps);
    resetShimState(TERMINAL_PROJECT);
    await enableProject(request, TERMINAL_PROJECT, { testsDisabled: true });
    await request.patch('/api/settings', { data: { jobs_paused: true } });

    await page.goto(`/project/${TERMINAL_PROJECT}/terminal`);
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('live run')).toHaveCount(0);

    const queuedResp = await request.post(`/api/projects/by-project/${TERMINAL_PROJECT}/release`, {
      data: { queue_if_blocked: true },
    });
    expect(
      queuedResp.status(),
      `queued release POST failed: ${await queuedResp.text()}`,
    ).toBe(202);

    await expect(page).toHaveURL(`/project/${TERMINAL_PROJECT}/terminal`);
    await expect(page.getByText('live run')).toHaveCount(0);

    const pauseToggle = page.getByRole('switch', { name: /jobs paused/i });
    await expect(pauseToggle).toHaveAttribute('aria-checked', 'true');
    await pauseToggle.click();

    const runningRelease = await waitForJobRunning(request, TERMINAL_PROJECT, 'release', 20_000);
    expect(runningRelease, 'queued release should start after resuming jobs').not.toBeNull();

    await expect(page).toHaveURL(
      new RegExp(`/project/${TERMINAL_PROJECT}/terminal\\?job=${encodeURIComponent(String(runningRelease?.['id']))}`),
      { timeout: 20_000 },
    );
    await expect(page.getByText('live run')).toBeVisible({ timeout: 20_000 });

    const result = await waitForPipelineCompletion(request, TERMINAL_PROJECT, 90_000);
    expect(result.status, 'queued release should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'queued release exit code').toBe(0);

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 15_000 });
  });
});
