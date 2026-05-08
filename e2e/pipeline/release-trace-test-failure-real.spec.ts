import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  writeGitTiming,
  enableProject,
  waitForPipelineCompletion,
  waitForJobRunning,
} from './helpers';
import { WORKSPACE_DIR } from './global-setup';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'strip-test-fail-live.json'), 'utf-8'),
);

const PROJECT = 'strip-test-fail-live';
const STEP_DELAY_MS = 6500;
const FIX_MARKER = '.tamtam-fixed-by-shim';

test.describe('Real release trace after initial test failure', () => {
  test('release trace surfaces the failed test log excerpt before the pipeline recovers to success', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    writeGitTiming(PROJECT, { push: STEP_DELAY_MS });
    rmSync(join(WORKSPACE_DIR, PROJECT, FIX_MARKER), { force: true });
    await enableProject(request, PROJECT, { testsDisabled: false });

    const configResp = await request.patch(
      `/api/projects/by-project/${PROJECT}/config`,
      {
        data: {
          test_command: `bash -lc 'if [ ! -f ${FIX_MARKER} ]; then echo first-test-failed; sleep 6; exit 1; fi; echo second-test-passed; sleep 6'`,
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
    expect(runningTest, 'initial test job should be running').not.toBeNull();

    await page.goto(
      `/project/${PROJECT}/release/${encodeURIComponent(releaseBody.release_job_id)}`,
    );

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('test').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('running…').first()).toBeVisible({ timeout: 8_000 });

    await expect(page.getByText('fix').first()).toBeVisible({ timeout: 20_000 });
    expect(
      existsSync(join(WORKSPACE_DIR, PROJECT, FIX_MARKER)),
      'fix marker should not exist until the fix step finishes',
    ).toBe(false);

    const retryTest = await waitForJobRunning(request, PROJECT, 'test', 20_000);
    expect(retryTest, 'retry test should start after the fix step completes').not.toBeNull();
    expect(
      existsSync(join(WORKSPACE_DIR, PROJECT, FIX_MARKER)),
      'fix marker should exist once the pipeline advances to the retry test',
    ).toBe(true);

    const result = await waitForPipelineCompletion(request, PROJECT, 120_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(page.getByText('success').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('6 steps')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });

    const testRows = page.locator('button').filter({ hasText: 'test' });
    await expect(testRows).toHaveCount(2, { timeout: 8_000 });

    await testRows.first().click();
    await expect(page.getByText('first-test-failed')).toBeVisible({ timeout: 8_000 });

    await testRows.nth(1).click();
    await expect(page.getByText('second-test-passed')).toBeVisible({ timeout: 8_000 });
  });
});
