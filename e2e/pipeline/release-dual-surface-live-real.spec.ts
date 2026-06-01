import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  enableProject,
  writeGitTiming,
  waitForJobRunning,
  waitForPipelineCompletion,
  waitForJobCompletion,
} from './helpers';

const SUCCESS_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);

const SUCCESS_PROJECT = 'dual-surface-release';
const CANCELLED_PROJECT = 'dual-surface-release-cancelled';
const ACTIVE_PIPELINE_SUMMARY =
  /pipeline summary: (release|test|review|fix|commit|push|dod|merge|soak) running/i;

test.describe('Real release lifecycle across history and terminal surfaces', () => {
  test('an externally-started release appears live on history and terminal, then settles to success on both without reload', async ({
    page,
    request,
  }) => {
    writeScenario(SUCCESS_PROJECT, SUCCESS_SCENARIO.steps);
    resetShimState(SUCCESS_PROJECT);
    writeGitTiming(SUCCESS_PROJECT, { push: 6500 });
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    const terminalPage = await page.context().newPage();

    await page.goto(`/project/${SUCCESS_PROJECT}/history`);
    await terminalPage.goto(`/project/${SUCCESS_PROJECT}/terminal`);

    await expect(page.getByText('No runs yet').first()).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(terminalPage.getByText('live run')).toHaveCount(0);

    const releaseResp = await request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, SUCCESS_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    const releaseRow = page.getByRole('button').filter({ hasText: 'Release pipeline' }).first();

    await expect(releaseRow).toBeVisible({ timeout: 20_000 });
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No runs yet')).toHaveCount(0, { timeout: 20_000 });

    await expect(terminalPage).toHaveURL(
      new RegExp(
        `/project/${SUCCESS_PROJECT}/terminal\\?job=${encodeURIComponent(releaseBody.release_job_id)}`,
      ),
      { timeout: 20_000 },
    );
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(terminalPage.getByLabel(ACTIVE_PIPELINE_SUMMARY)).toBeVisible({
      timeout: 20_000,
    });

    const result = await waitForPipelineCompletion(
      request,
      SUCCESS_PROJECT,
      90_000,
      releaseBody.release_job_id,
    );
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(releaseRow.getByLabel('done')).toBeVisible({ timeout: 15_000 });
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });

    await expect(terminalPage.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(terminalPage.getByLabel(/pipeline summary:/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(terminalPage.getByText('exit 0 — ok').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('an externally-started release clears the live spinner on history and terminal after abort without reload', async ({
    page,
    request,
  }) => {
    writeScenario(CANCELLED_PROJECT, ABORT_SCENARIO.steps);
    resetShimState(CANCELLED_PROJECT);
    await enableProject(request, CANCELLED_PROJECT, { testsDisabled: true });

    const terminalPage = await page.context().newPage();

    await page.goto(`/project/${CANCELLED_PROJECT}/history`);
    await terminalPage.goto(`/project/${CANCELLED_PROJECT}/terminal`);

    await expect(page.getByText('No runs yet').first()).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(terminalPage.getByText('live run')).toHaveCount(0);

    const releaseResp = await request.post(`/api/projects/by-project/${CANCELLED_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, CANCELLED_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    const releaseRow = page.getByRole('button').filter({ hasText: 'Release pipeline' }).first();

    await expect(releaseRow).toBeVisible({ timeout: 20_000 });
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No runs yet')).toHaveCount(0, { timeout: 20_000 });

    await expect(terminalPage).toHaveURL(
      new RegExp(
        `/project/${CANCELLED_PROJECT}/terminal\\?job=${encodeURIComponent(releaseBody.release_job_id)}`,
      ),
      { timeout: 20_000 },
    );
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(terminalPage.getByLabel(/pipeline summary: review running/i)).toBeVisible({
      timeout: 20_000,
    });

    const abortResp = await request.post(
      `/api/projects/by-project/${CANCELLED_PROJECT}/release/abort`,
    );
    expect(abortResp.status()).toBe(200);

    const releaseJob = await waitForJobCompletion(request, releaseBody.release_job_id, 15_000);
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3);

    await expect(releaseRow.getByText('cancelled at review')).toBeVisible({ timeout: 15_000 });
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });

    await expect(terminalPage.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(terminalPage.getByLabel(/pipeline summary:/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(terminalPage.getByText('cancelled').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(terminalPage.getByText('exit -3')).toHaveCount(0);
  });
});
