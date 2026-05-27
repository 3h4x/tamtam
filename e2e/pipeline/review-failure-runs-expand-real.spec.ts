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

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-failure.json'), 'utf-8'),
);

const PROJECT = 'review-failure-runs-expand';

test.describe('Real review failure drill-in from global runs', () => {
  test('failed review expands into nested steps and opens the review findings from /runs without reload', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const runningReview = await waitForJobRunning(request, PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto(`/runs?project=${encodeURIComponent(PROJECT)}`);

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('span.animate-pulse').first()).toBeVisible({ timeout: 8_000 });

    const result = await waitForPipelineCompletion(request, PROJECT, 30_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(page.getByText('release failed').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });

    const expandButton = page.getByTitle('Expand steps').first();
    await expect(expandButton).toBeVisible({ timeout: 8_000 });
    await expandButton.click();

    const reviewStep = page.getByText('Code review').last();
    await expect(reviewStep).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('✗ DNS').last()).toBeVisible({ timeout: 8_000 });

    await reviewStep.click();

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=`),
      { timeout: 8_000 },
    );
    await expect(page.getByText(/critical security vulnerabilities/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/DO NOT SHIP/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
