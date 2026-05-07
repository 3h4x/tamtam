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

const UI_LIVE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);

const DONE_PROJECT = 'history-live-done';
const ABORT_PROJECT = 'history-live-abort';

test.describe('History tab live lifecycle', () => {
  test('history tab clears running state and shows done after a real release finishes without reload', async ({
    page,
    request,
  }) => {
    writeScenario(DONE_PROJECT, UI_LIVE_SCENARIO.steps);
    resetShimState(DONE_PROJECT);
    await enableProject(request, DONE_PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${DONE_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const runningJob = await waitForJobRunning(request, DONE_PROJECT, 'review', 20_000);
    expect(runningJob, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${DONE_PROJECT}/history`);

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });

    const result = await waitForPipelineCompletion(request, DONE_PROJECT, 90_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(page.getByText('done').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 12_000,
    });
  });

  test('history tab clears running state and shows cancelled after abort without reload', async ({
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
    const releaseJobId = releaseBody.release_job_id;
    expect(releaseJobId, 'release_job_id in response').toBeTruthy();

    const runningJob = await waitForJobRunning(request, ABORT_PROJECT, 'review', 20_000);
    expect(runningJob, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${ABORT_PROJECT}/history`);

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });

    const abortResp = await request.post(`/api/projects/by-project/${ABORT_PROJECT}/release/abort`);
    expect(abortResp.status()).toBe(200);

    const releaseJob = await waitForJobCompletion(request, releaseJobId, 10_000);
    expect(releaseJob, 'release job should finish after abort').not.toBeNull();
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3);

    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 12_000,
    });
  });
});
