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
  waitForJobCompletion,
} from './helpers';

const FULL_TRACE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'strip-full-live.json'), 'utf-8'),
);
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);

const SUCCESS_PROJECT = 'strip-full-live';
const ABORT_PROJECT = 'abort';
const STEP_DELAY_MS = 6500;

test.describe('Real release trace lifecycle', () => {
  test('release trace polls through the full fix-loop pipeline and lands on success without reload', async ({
    page,
    request,
  }) => {
    writeScenario(SUCCESS_PROJECT, FULL_TRACE_SCENARIO.steps);
    resetShimState(SUCCESS_PROJECT);
    writeGitTiming(SUCCESS_PROJECT, { commit: STEP_DELAY_MS, push: STEP_DELAY_MS });
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: false });

    const configResp = await request.patch(
      `/api/projects/by-project/${SUCCESS_PROJECT}/config`,
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

    const releaseResp = await request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningTest = await waitForJobRunning(request, SUCCESS_PROJECT, 'test', 20_000);
    expect(runningTest, 'test job should be running').not.toBeNull();

    await page.goto(
      `/project/${SUCCESS_PROJECT}/release/${encodeURIComponent(releaseBody.release_job_id)}`,
    );

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('1 step')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('test').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('running…').first()).toBeVisible({ timeout: 8_000 });

    await expect(page.getByText('review').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('fix').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('commit').first()).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText('push').first()).toBeVisible({ timeout: 50_000 });

    const result = await waitForPipelineCompletion(request, SUCCESS_PROJECT, 120_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(page.getByText('success').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('7 steps')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('LGTM').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('running…')).toHaveCount(0, { timeout: 15_000 });
  });

  test('release trace clears its running state and shows cancelled after abort without reload', async ({
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

    await page.goto(
      `/project/${ABORT_PROJECT}/release/${encodeURIComponent(releaseBody.release_job_id)}`,
    );

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('review').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('running…').first()).toBeVisible({ timeout: 8_000 });

    const abortResp = await request.post(`/api/projects/by-project/${ABORT_PROJECT}/release/abort`);
    expect(abortResp.status()).toBe(200);

    const releaseJob = await waitForJobCompletion(request, releaseBody.release_job_id, 10_000);
    expect(releaseJob, 'release job should finish after abort').not.toBeNull();
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3);

    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('running…')).toHaveCount(0, { timeout: 15_000 });
  });
});
