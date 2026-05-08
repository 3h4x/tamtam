import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  writeGitTiming,
  writeGitFailures,
  enableProject,
  waitForPipelineCompletion,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);

const PROJECT = 'push-failure-live';
const PUSH_DELAY_MS = 6500;
const PUSH_ERROR = 'rejected by remote hook';

test.describe('Real push failure lifecycle', () => {
  test.beforeEach(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    writeGitTiming(PROJECT, { push: PUSH_DELAY_MS });
    writeGitFailures(PROJECT, {
      push: {
        exitCode: 1,
        stderr: `${PUSH_ERROR}\n`,
      },
    });
    await enableProject(request, PROJECT, { testsDisabled: true });
  });

  test('terminal strip reaches push, disappears on failure, and leaves the push error visible', async ({
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

    await page.goto(`/project/${PROJECT}/terminal?job=${encodeURIComponent(releaseBody.release_job_id)}`);

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel(/pipeline summary: push running/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByLabel(/push: running\./i)).toBeVisible({ timeout: 30_000 });

    const result = await waitForPipelineCompletion(request, PROJECT, 90_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(`Push failed: ${PUSH_ERROR}`).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('release trace flips from running to failed and exposes the push error excerpt', async ({
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

    await page.goto(
      `/project/${PROJECT}/release/${encodeURIComponent(releaseBody.release_job_id)}`,
    );

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('push').first()).toBeVisible({ timeout: 40_000 });

    const result = await waitForPipelineCompletion(request, PROJECT, 90_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(page.getByText('failed').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('running…')).toHaveCount(0, { timeout: 15_000 });

    await page.getByRole('button', { name: /push/i }).first().click();
    await expect(page.getByText(`Push failed: ${PUSH_ERROR}`).first()).toBeVisible({
      timeout: 8_000,
    });
  });
});
