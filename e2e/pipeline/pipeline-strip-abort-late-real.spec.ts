import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  readShimState,
  writeGitTiming,
  enableProject,
  waitForJobRunning,
  waitForJobCompletion,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'strip-full-live.json'), 'utf-8'),
 ) as { steps: Array<{ label?: string; sleep_ms?: number; text: string }> };

const PUSH_SCENARIO = {
  steps: SCENARIO.steps.map((step) =>
    step.label === 'commit-message'
      ? { ...step, sleep_ms: 0 }
      : step
  ),
};

const PROJECT = 'strip-full-live';
const STEP_DELAY_MS = 6500;

test.describe('Real pipeline strip abort lifecycle', () => {
  test('terminal strip shows completed earlier steps, then clears after aborting during push', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, PUSH_SCENARIO.steps);
    resetShimState(PROJECT);
    writeGitTiming(PROJECT, { push: STEP_DELAY_MS });
    await enableProject(request, PROJECT, { testsDisabled: true, autoPushEnabled: true });

    const configResp = await request.patch(
      `/api/projects/by-project/${PROJECT}/config`,
      {
        data: {
          tests_disabled: true,
          review_disabled: true,
          auto_push_enabled: true,
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

    const runningPush = await waitForJobRunning(request, PROJECT, 'push', 30_000);
    expect(runningPush, 'push job should be running before opening terminal').not.toBeNull();

    await page.goto(`/project/${PROJECT}/terminal?job=${encodeURIComponent(releaseBody.release_job_id)}`);

    await expect(page.getByLabel(/commit: done\./i)).toBeVisible({ timeout: 12_000 });
    await expect(page.getByLabel(/pipeline summary: push running/i)).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByLabel(/push: running\./i)).toBeVisible({ timeout: 12_000 });

    const abortResp = await request.post(`/api/projects/by-project/${PROJECT}/release/abort`);
    expect(abortResp.status()).toBe(200);

    const releaseJob = await waitForJobCompletion(request, releaseBody.release_job_id, 15_000);
    expect(releaseJob, 'release job should finish after abort').not.toBeNull();
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3);

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 });

    const gitState = readShimState(PROJECT);
    expect(gitState.committed, 'commit should have completed before push abort').toBe(true);
    expect(gitState.pushed, 'push should not complete after abort').toBe(false);
  });
});
