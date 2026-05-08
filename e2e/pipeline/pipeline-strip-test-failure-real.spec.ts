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

test.describe('Real pipeline strip after initial test failure', () => {
  test('terminal strip transitions test → fix → test → review → commit → push and disappears on success', async ({
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

    await page.goto(`/project/${PROJECT}/terminal`);
    await expect(page.getByRole('button', { name: 'new' })).toBeVisible({ timeout: 8_000 });

    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();
    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=${encodeURIComponent(releaseBody.release_job_id)}`),
      { timeout: 20_000 },
    );

    await expect(page.getByLabel(/pipeline summary: test running/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel(/test: running\./i)).toBeVisible({ timeout: 8_000 });

    await expect(page.getByLabel(/pipeline summary: fix running/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel(/fix: running\./i)).toBeVisible({ timeout: 20_000 });
    expect(
      existsSync(join(WORKSPACE_DIR, PROJECT, FIX_MARKER)),
      'fix marker must not exist before the fix step completes',
    ).toBe(false);

    const retryTestJob = await waitForJobRunning(request, PROJECT, 'test', 20_000);
    expect(retryTestJob, 'retry test should not start until the fix step completes').not.toBeNull();
    expect(
      existsSync(join(WORKSPACE_DIR, PROJECT, FIX_MARKER)),
      'fix marker must be visible once TamTam advances from fix to the retry test',
    ).toBe(true);

    await expect(page.getByLabel(/pipeline summary: test running/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('second-test-passed').first()).toBeVisible({ timeout: 20_000 });

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel(/review: running\./i)).toBeVisible({ timeout: 20_000 });

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
    expect(
      existsSync(join(WORKSPACE_DIR, PROJECT, FIX_MARKER)),
      'fix step should create the marker that allows the retry to pass',
    ).toBe(true);

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
