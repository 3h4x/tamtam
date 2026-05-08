import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  writeGitTiming,
  enableProject,
  waitForJobRunning,
  waitForPipelineCompletion,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'strip-full-live.json'), 'utf-8'),
);

const PROJECT = 'strip-full-live';
const STEP_DELAY_MS = 6500;

test.describe('Real full pipeline strip lifecycle', () => {
  test('terminal strip advances through test, review, fix, commit, and push before disappearing on success', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    writeGitTiming(PROJECT, { push: STEP_DELAY_MS });
    await enableProject(request, PROJECT, { testsDisabled: false });

    const configResp = await request.patch(
      `/api/projects/by-project/${PROJECT}/config`,
      {
        data: {
          test_command: 'bash -lc "echo test-start; sleep 6; echo test-done"',
          tests_disabled: false,
        },
      },
    );
    expect(
      configResp.status(),
      `config PATCH failed: ${await configResp.text()}`,
    ).toBe(200);

    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningTest = await waitForJobRunning(request, PROJECT, 'test', 20_000);
    expect(runningTest, 'test job should be running').not.toBeNull();

    await page.goto(`/project/${PROJECT}/terminal?job=${encodeURIComponent(releaseBody.release_job_id)}`);

    await expect(page.getByLabel(/pipeline summary: test running/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel(/test: running\./i)).toBeVisible({ timeout: 8_000 });

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel(/review: running\./i)).toBeVisible({ timeout: 20_000 });

    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel(/fix: running\./i)).toBeVisible({ timeout: 20_000 });

    await expect(page.getByLabel(/pipeline summary: commit running/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel(/commit: running\./i)).toBeVisible({ timeout: 20_000 });

    await expect(page.getByLabel(/pipeline summary: push running/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel(/push: running\./i)).toBeVisible({ timeout: 20_000 });

    const result = await waitForPipelineCompletion(request, PROJECT, 120_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
