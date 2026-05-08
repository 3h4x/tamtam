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

const LONG_SUCCESS_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-long.json'), 'utf-8'),
);
const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-failure.json'), 'utf-8'),
);

const SUCCESS_PROJECT = 'runs-live';
const FAILURE_PROJECT = 'review-failure';

test.describe('Real concurrent runs lifecycle', () => {
  test('global runs list keeps concurrent release transitions isolated as one fails and the other later succeeds', async ({
    page,
    request,
  }) => {
    resetShimState(SUCCESS_PROJECT);
    writeScenario(SUCCESS_PROJECT, LONG_SUCCESS_SCENARIO.steps);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    resetShimState(FAILURE_PROJECT);
    writeScenario(FAILURE_PROJECT, FAILURE_SCENARIO.steps);
    await enableProject(request, FAILURE_PROJECT, { testsDisabled: true });

    const [successResp, failureResp] = await Promise.all([
      request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/release`),
      request.post(`/api/projects/by-project/${FAILURE_PROJECT}/release`),
    ]);

    expect(
      successResp.status(),
      `success release POST failed: ${await successResp.text()}`,
    ).toBe(200);
    expect(
      failureResp.status(),
      `failure release POST failed: ${await failureResp.text()}`,
    ).toBe(200);

    const [successReview, failureReview] = await Promise.all([
      waitForJobRunning(request, SUCCESS_PROJECT, 'review', 20_000),
      waitForJobRunning(request, FAILURE_PROJECT, 'review', 20_000),
    ]);
    expect(successReview, 'success project review should be running').not.toBeNull();
    expect(failureReview, 'failure project review should be running').not.toBeNull();

    await page.goto('/runs');

    await expect(page.getByText(SUCCESS_PROJECT).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(FAILURE_PROJECT).first()).toBeVisible({ timeout: 8_000 });
    const runningRows = page.locator('div.border-l-status-info span.animate-pulse');
    await expect(runningRows).toHaveCount(4, { timeout: 8_000 });

    const failureResult = await waitForPipelineCompletion(request, FAILURE_PROJECT, 30_000);
    expect(failureResult.status, 'failure pipeline should finish first').toBe('done');
    expect(failureResult.releaseJob?.['exit_code'], 'failure release exit code').not.toBe(0);

    const failureExitCode = Number(failureResult.releaseJob?.['exit_code']);
    expect(Number.isFinite(failureExitCode)).toBe(true);

    await expect(runningRows).toHaveCount(2, { timeout: 12_000 });
    await expect(page.getByText(`exit ${failureExitCode}`).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText(SUCCESS_PROJECT).first()).toBeVisible();
    await expect(page.getByText(FAILURE_PROJECT).first()).toBeVisible();

    const successResult = await waitForPipelineCompletion(request, SUCCESS_PROJECT, 90_000);
    expect(successResult.status, 'success pipeline should eventually complete').toBe('done');
    expect(successResult.releaseJob?.['exit_code'], 'success release exit code').toBe(0);

    await expect(runningRows).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('done').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(`exit ${failureExitCode}`).first()).toBeVisible();
  });
});
