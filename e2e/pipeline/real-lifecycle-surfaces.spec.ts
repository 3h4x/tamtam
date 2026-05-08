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

const UI_LIVE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);

const RUNS_PROJECT = 'runs-live';
const STRIP_PROJECT = 'strip-live';

test.describe('Real lifecycle UI surfaces', () => {
  test('global runs list shows a live running job, then flips to done without reload', async ({
    page,
    request,
  }) => {
    writeScenario(RUNS_PROJECT, UI_LIVE_SCENARIO.steps);
    resetShimState(RUNS_PROJECT);
    await enableProject(request, RUNS_PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${RUNS_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const reviewJob = await waitForJobRunning(request, RUNS_PROJECT, 'review', 20_000);
    expect(reviewJob, 'review job should be running').not.toBeNull();

    await page.goto(`/runs?project=${encodeURIComponent(RUNS_PROJECT)}`);

    await expect(page.getByText(RUNS_PROJECT).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('span.animate-pulse').first()).toBeVisible({ timeout: 8_000 });

    const result = await waitForPipelineCompletion(request, RUNS_PROJECT, 90_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(page.getByText('done').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 12_000,
    });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 12_000 });
  });

  test('terminal pipeline strip shows the live release chain and disappears when the release finishes', async ({
    page,
    request,
  }) => {
    writeScenario(STRIP_PROJECT, UI_LIVE_SCENARIO.steps);
    resetShimState(STRIP_PROJECT);
    await enableProject(request, STRIP_PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${STRIP_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    const releaseJobId = releaseBody.release_job_id;
    expect(releaseJobId, 'release_job_id in response').toBeTruthy();

    const reviewJob = await waitForJobRunning(request, STRIP_PROJECT, 'review', 20_000);
    expect(reviewJob, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${STRIP_PROJECT}/terminal?job=${encodeURIComponent(releaseJobId)}`);

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByTitle('View unified release trace')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'abort' })).toBeVisible({ timeout: 8_000 });

    const result = await waitForPipelineCompletion(request, STRIP_PROJECT, 90_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByTitle('review in progress — click to open terminal')).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
