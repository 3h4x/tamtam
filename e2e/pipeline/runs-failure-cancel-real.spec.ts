import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  enableProject,
  waitForJobRunning,
  waitForPipelineCompletion,
  waitForJobCompletion,
} from './helpers';

const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-failure.json'), 'utf-8'),
);
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);

const FAILURE_PROJECT = 'runs-failure-dns';
const ABORT_PROJECT = 'runs-abort-cancel';

test.describe('Real runs lifecycle failure states', () => {
  test('history tab flips from running to failed when a release review returns DO NOT SHIP', async ({
    page,
    request,
  }) => {
    writeScenario(FAILURE_PROJECT, FAILURE_SCENARIO.steps);
    resetShimState(FAILURE_PROJECT);
    await enableProject(request, FAILURE_PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${FAILURE_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const runningReview = await waitForJobRunning(request, FAILURE_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${FAILURE_PROJECT}/history`);

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('span.animate-pulse').first()).toBeVisible({ timeout: 8_000 });

    const result = await waitForPipelineCompletion(request, FAILURE_PROJECT, 30_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(page.getByText('release failed').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('✗ DNS').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });

    const expandButton = page.getByTitle('Expand steps').first();
    await expect(expandButton).toBeVisible({ timeout: 8_000 });
    await expandButton.click();

    await expect(page.getByText('Code review').last()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('✗ DNS').last()).toBeVisible({ timeout: 8_000 });
  });

  test('global runs list clears live state and shows cancelled after abort without reload', async ({
    page,
    request,
  }) => {
    writeScenario(ABORT_PROJECT, ABORT_SCENARIO.steps);
    resetShimState(ABORT_PROJECT);
    await enableProject(request, ABORT_PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${ABORT_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, ABORT_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto(`/runs?project=${encodeURIComponent(ABORT_PROJECT)}`);

    await expect(page.getByText(ABORT_PROJECT).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('span.animate-pulse').first()).toBeVisible({ timeout: 8_000 });

    const abortResp = await request.post(`/api/projects/by-project/${ABORT_PROJECT}/release/abort`);
    expect(abortResp.status()).toBe(200);

    const releaseJob = await waitForJobCompletion(request, releaseBody.release_job_id, 10_000);
    expect(releaseJob, 'release job should finish after abort').not.toBeNull();
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3);

    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });
  });
});
