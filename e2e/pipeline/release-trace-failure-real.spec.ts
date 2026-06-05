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

const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-failure.json'), 'utf-8'),
);

const PROJECT = 'review-failure';
const DEFAULT_DO_NOT_SHIP_ACTION = 'fix';

test.describe('Real failed release lifecycle surfaces', () => {
  test.beforeEach(async ({ request }) => {
    writeScenario(PROJECT, FAILURE_SCENARIO.steps);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });
    const patch = await request.patch('/api/settings', {
      data: { review_do_not_ship_action: 'abort' },
    });
    expect(
      patch.ok(),
      `failed to set review_do_not_ship_action: ${patch.status()}`,
    ).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    const patch = await request.patch('/api/settings', {
      data: { review_do_not_ship_action: DEFAULT_DO_NOT_SHIP_ACTION },
    });
    expect(
      patch.ok(),
      `failed to restore review_do_not_ship_action: ${patch.status()}`,
    ).toBe(true);
  });

  test('release trace flips from running to cancelled and exposes the review findings without reload', async ({
    page,
    request,
  }) => {
    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto(
      `/project/${PROJECT}/release/${encodeURIComponent(releaseBody.release_job_id)}`,
    );

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('review').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('running…').first()).toBeVisible({ timeout: 8_000 });

    const result = await waitForPipelineCompletion(request, PROJECT, 30_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('DO NOT SHIP').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('running…')).toHaveCount(0, { timeout: 15_000 });

    await page.getByRole('button', { name: /review/i }).first().click();
    await expect(page.getByText(/critical security vulnerabilities/i)).toBeVisible({
      timeout: 8_000,
    });
  });

  test('terminal pipeline strip disappears after a failed release and leaves the failure verdict visible', async ({
    page,
    request,
  }) => {
    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${PROJECT}/terminal?job=${encodeURIComponent(releaseBody.release_job_id)}`);

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByTitle('View unified release trace').first()).toBeVisible({
      timeout: 8_000,
    });

    const result = await waitForPipelineCompletion(request, PROJECT, 30_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByTitle('review in progress — click to open terminal')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText(/DO NOT SHIP/).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/critical security vulnerabilities/i)).toBeVisible({
      timeout: 8_000,
    });
  });
});
