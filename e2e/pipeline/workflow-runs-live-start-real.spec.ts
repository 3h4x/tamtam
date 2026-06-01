import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  acquirePipelineSharedStateLock,
  type PipelineSharedStateLock,
  writeScenario,
  resetShimState,
  enableProject,
  waitForJobRunning,
  waitForJobCompletion,
  waitForPipelineCompletion,
} from './helpers';
import { E2E_BASE } from './global-setup';

const BASE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);
const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-failure.json'), 'utf-8'),
);

const SUCCESS_PROJECT = 'workflow-runs-live-start-real';
const CANCELLED_PROJECT = 'workflow-runs-live-start-cancelled';
const FAILURE_PROJECT = 'workflow-runs-live-start-failure';
const SUCCESS_STEPS = BASE_SCENARIO.steps.map(
  (step: { label?: string; sleep_ms?: number; text: string }) =>
    step.label === 'review' ? { ...step, sleep_ms: 10_000 } : step,
);
const FAILURE_STEPS = FAILURE_SCENARIO.steps.map(
  (step: { label?: string; sleep_ms?: number; text: string }) =>
    step.label === 'review' ? { ...step, sleep_ms: 10_000 } : step,
);
const DEFAULT_DO_NOT_SHIP_ACTION = 'fix';
let sharedStateLock: PipelineSharedStateLock | null = null;

function workflowRunLink(scope: Locator, project: string): Locator {
  return scope.getByRole('link').filter({ hasText: project }).first();
}

test.describe('Real workflow-runs live start transitions', () => {
  test.beforeEach(async () => {
    sharedStateLock = await acquirePipelineSharedStateLock('workflow-runs-live-start-real');
    rmSync(join(E2E_BASE, 'workflow-data'), { recursive: true, force: true });
    mkdirSync(join(E2E_BASE, 'workflow-data', 'runs'), { recursive: true });
    mkdirSync(join(E2E_BASE, 'workflow-data', 'steps'), { recursive: true });
  });

  test.afterEach(async ({ request }) => {
    try {
      const patch = await request.patch('/api/settings', {
        data: { review_do_not_ship_action: DEFAULT_DO_NOT_SHIP_ACTION },
      });
      expect(
        patch.ok(),
        `failed to restore review_do_not_ship_action: ${patch.status()}`,
      ).toBe(true);
    } finally {
      sharedStateLock?.release();
      sharedStateLock = null;
    }
  });

  test('workflow-runs page picks up a newly-started release and settles it to completed without reload', async ({
    page,
    request,
  }) => {
    resetShimState(SUCCESS_PROJECT);
    writeScenario(SUCCESS_PROJECT, SUCCESS_STEPS);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    await page.goto('/workflow-runs');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('link', { name: new RegExp(SUCCESS_PROJECT, 'i') })).toHaveCount(0);

    const releaseResp = await request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, SUCCESS_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    const stableUrl = page.url();
    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByLabel('status running').first()).toBeVisible({
      timeout: 12_000,
    });

    const result = await waitForPipelineCompletion(
      request,
      SUCCESS_PROJECT,
      90_000,
      releaseBody.release_job_id,
    );
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toHaveCount(0, { timeout: 15_000 });
    const completedRow = page.getByRole('row').filter({ hasText: SUCCESS_PROJECT }).first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(stableUrl);
  });

  test('workflow-runs page picks up a newly-started release and settles it to cancelled without reload', async ({
    page,
    request,
  }) => {
    resetShimState(CANCELLED_PROJECT);
    writeScenario(CANCELLED_PROJECT, ABORT_SCENARIO.steps);
    await enableProject(request, CANCELLED_PROJECT, { testsDisabled: true });

    await page.goto('/workflow-runs');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });

    const releaseResp = await request.post(`/api/projects/by-project/${CANCELLED_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, CANCELLED_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    const stableUrl = page.url();
    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(workflowRunLink(activePanel, CANCELLED_PROJECT)).toBeVisible({
      timeout: 12_000,
    });
    await expect(activePanel.getByLabel('status running').first()).toBeVisible({
      timeout: 12_000,
    });

    const abortResp = await request.post(
      `/api/projects/by-project/${CANCELLED_PROJECT}/release/abort`,
    );
    expect(abortResp.status()).toBe(200);

    const cancelledRelease = await waitForJobCompletion(request, releaseBody.release_job_id, 15_000);
    expect(cancelledRelease?.['exit_code'], 'release exit code after abort').toBe(-3);

    await expect(workflowRunLink(activePanel, CANCELLED_PROJECT)).toHaveCount(0, {
      timeout: 15_000,
    });
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const cancelledRow = workflowRunLink(attentionPanel, CANCELLED_PROJECT);
    await expect(cancelledRow).toBeVisible({ timeout: 15_000 });
    await expect(cancelledRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(cancelledRow.getByText('exit -3')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 15_000 });
    await expect(page).toHaveURL(stableUrl);
  });

  test('workflow-runs page picks up a newly-started release and moves it to attention after a blocked review without reload', async ({
    page,
    request,
  }) => {
    resetShimState(FAILURE_PROJECT);
    writeScenario(FAILURE_PROJECT, FAILURE_STEPS);
    await enableProject(request, FAILURE_PROJECT, { testsDisabled: true });

    const patch = await request.patch('/api/settings', {
      data: { review_do_not_ship_action: 'abort' },
    });
    expect(
      patch.ok(),
      `failed to set review_do_not_ship_action: ${patch.status()}`,
    ).toBe(true);

    await page.goto('/workflow-runs');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });

    const releaseResp = await request.post(`/api/projects/by-project/${FAILURE_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, FAILURE_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    const stableUrl = page.url();
    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(workflowRunLink(activePanel, FAILURE_PROJECT)).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByLabel('status running').first()).toBeVisible({
      timeout: 12_000,
    });

    const result = await waitForPipelineCompletion(
      request,
      FAILURE_PROJECT,
      90_000,
      releaseBody.release_job_id,
    );
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(workflowRunLink(activePanel, FAILURE_PROJECT)).toHaveCount(0, {
      timeout: 15_000,
    });
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const failedRow = workflowRunLink(attentionPanel, FAILURE_PROJECT);
    await expect(failedRow).toBeVisible({ timeout: 15_000 });
    await expect(failedRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(failedRow.getByText('DO NOT SHIP')).toBeVisible({ timeout: 15_000 });
    await expect(attentionPanel.getByText('1 run')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /completed \d+/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 15_000 });
    await expect(page).toHaveURL(stableUrl);
  });
});
