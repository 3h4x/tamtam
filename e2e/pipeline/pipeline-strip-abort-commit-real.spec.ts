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

const RAW_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'strip-full-live.json'), 'utf-8'),
) as { steps: Array<{ label?: string; sleep_ms?: number; text: string }> };

const SCENARIO = {
  steps: RAW_SCENARIO.steps.map((step) =>
    step.label === 'commit-message'
      ? { ...step, sleep_ms: 0 }
      : step
  ),
};

const PROJECT = 'strip-abort-commit';
const STEP_DELAY_MS = 6500;

test.describe('Real pipeline commit abort lifecycle', () => {
  test('aborting during commit clears the strip and prevents commit/push side effects', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    writeGitTiming(PROJECT, { commit: STEP_DELAY_MS });
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

    const runningCommit = await waitForJobRunning(request, PROJECT, 'commit', 30_000);
    expect(runningCommit, 'commit job should be running before opening terminal').not.toBeNull();

    await page.goto(`/project/${PROJECT}/terminal?job=${encodeURIComponent(releaseBody.release_job_id)}`);

    await expect(page.getByLabel(/pipeline summary: commit running/i)).toBeVisible({ timeout: 12_000 });
    await expect(page.getByLabel(/commit: running\./i)).toBeVisible({ timeout: 12_000 });

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

    const gitState = readShimState(PROJECT);
    expect(gitState.committed, 'commit should not complete after abort').toBe(false);
    expect(gitState.pushed, 'push should not complete after commit abort').toBe(false);
  });
});
