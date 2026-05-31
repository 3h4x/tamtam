import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  enableProject,
  waitForJobRunning,
  waitForJobCompletion,
} from './helpers';

const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-failure.json'), 'utf-8'),
);
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);
const SUCCESS_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-long.json'), 'utf-8'),
);

const SUCCESS_PROJECT = 'workflow-run-detail-success';
const FAILURE_PROJECT = 'workflow-run-detail-failure';
const CANCELLED_PROJECT = 'workflow-run-detail-abort';
const LONG_FAILURE_STEPS = FAILURE_SCENARIO.steps.map(
  (step: { label?: string; sleep_ms?: number; text: string }) =>
    step.label === 'review' ? { ...step, sleep_ms: 10_000 } : step,
);

type WorkflowRunDetail = {
  run: {
    id: string;
    status: string;
    error: string | null;
  };
  steps: Array<{
    status: string;
    error: string | null;
  }>;
};

async function waitForWorkflowRunTerminal(
  request: APIRequestContext,
  runId: string,
  timeoutMs = 30_000,
): Promise<WorkflowRunDetail> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail: WorkflowRunDetail | null = null;
  while (Date.now() < deadline) {
    const resp = await request.get(`/api/workflow-runs/${encodeURIComponent(runId)}`);
    if (resp.ok()) {
      lastDetail = (await resp.json()) as WorkflowRunDetail;
      if (lastDetail.run.status !== 'running' && lastDetail.run.status !== 'pending') {
        return lastDetail;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Timed out waiting for workflow run ${runId} to finish; last status was ${lastDetail?.run.status ?? 'missing'}`,
  );
}

test.describe('Real workflow-run detail live transitions', () => {
  test('successful release detail flips from live running to final completed snapshot without reload', async ({
    page,
    request,
  }) => {
    writeScenario(SUCCESS_PROJECT, SUCCESS_SCENARIO.steps);
    resetShimState(SUCCESS_PROJECT);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const runningReview = await waitForJobRunning(request, SUCCESS_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    const runningRunLink = activePanel.getByRole('link').filter({ hasText: SUCCESS_PROJECT }).first();
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(runningRunLink).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByLabel('status running').first()).toBeVisible({
      timeout: 12_000,
    });

    const runHref = await runningRunLink.getAttribute('href');
    expect(runHref, 'workflow run link href').toBeTruthy();
    const runId = runHref?.split('/').pop();
    expect(runId, 'workflow run id from href').toBeTruthy();

    await page.goto(runHref!);

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });
    await expect(
      page.locator('p').filter({ hasText: `Project ${SUCCESS_PROJECT}` }).first(),
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/running\s*1/i).first()).toBeVisible({ timeout: 8_000 });

    const stableUrl = page.url();

    const completedRun = await waitForWorkflowRunTerminal(request, runId!, 60_000);
    expect(completedRun.run.status, 'workflow run should complete').toBe('completed');

    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.locator('[aria-label="status completed"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/completed\s*[1-9]/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('needs attention')).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
  });

  test('failed release detail flips from live running to final failed snapshot without reload', async ({
    page,
    request,
  }) => {
    writeScenario(FAILURE_PROJECT, LONG_FAILURE_STEPS);
    resetShimState(FAILURE_PROJECT);
    await enableProject(request, FAILURE_PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${FAILURE_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const runningReview = await waitForJobRunning(request, FAILURE_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    const runningRunLink = activePanel.getByRole('link').filter({ hasText: FAILURE_PROJECT }).first();
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(runningRunLink).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByLabel('status running').first()).toBeVisible({
      timeout: 12_000,
    });

    const runHref = await runningRunLink.getAttribute('href');
    expect(runHref, 'workflow run link href').toBeTruthy();
    const runId = runHref?.split('/').pop();
    expect(runId, 'workflow run id from href').toBeTruthy();

    await page.goto(runHref!);

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });
    await expect(
      page.locator('p').filter({ hasText: `Project ${FAILURE_PROJECT}` }).first(),
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/running\s*1/i).first()).toBeVisible({ timeout: 8_000 });

    const stableUrl = page.url();

    const failedRun = await waitForWorkflowRunTerminal(request, runId!, 60_000);
    expect(failedRun.run.status, 'workflow run should leave the live state').not.toBe('running');
    expect(failedRun.run.status, 'workflow run should leave the pending state').not.toBe('pending');

    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.locator(`[aria-label="status ${failedRun.run.status}"]`).first()).toBeVisible({
      timeout: 15_000,
    });
    if (failedRun.steps.some((step) => step.status === 'failed')) {
      await expect(page.getByText(/failed\s*1/i).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('needs attention')).toBeVisible({ timeout: 15_000 });
    }
    if (failedRun.run.error) {
      await expect(page.getByText(failedRun.run.error.split('\n')[0].slice(0, 80)).first()).toBeVisible({
        timeout: 15_000,
      });
    }
    await expect(page).toHaveURL(stableUrl);
  });

  test('cancelled release detail flips from live running to cancelled final snapshot without reload', async ({
    page,
    request,
  }) => {
    writeScenario(CANCELLED_PROJECT, ABORT_SCENARIO.steps);
    resetShimState(CANCELLED_PROJECT);
    await enableProject(request, CANCELLED_PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${CANCELLED_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, CANCELLED_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    const runningRunLink = activePanel.getByRole('link').filter({ hasText: CANCELLED_PROJECT }).first();
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(runningRunLink).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByLabel('status running').first()).toBeVisible({
      timeout: 12_000,
    });

    const runHref = await runningRunLink.getAttribute('href');
    expect(runHref, 'workflow run link href').toBeTruthy();
    const runId = runHref?.split('/').pop();
    expect(runId, 'workflow run id from href').toBeTruthy();

    await page.goto(runHref!);

    await expect(page.locator('[aria-label="status running"]').first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('live · refreshes every 5s')).toBeVisible({ timeout: 8_000 });
    await expect(
      page.locator('p').filter({ hasText: `Project ${CANCELLED_PROJECT}` }).first(),
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/running\s*1/i).first()).toBeVisible({ timeout: 8_000 });

    const stableUrl = page.url();

    const abortResp = await request.post(`/api/projects/by-project/${CANCELLED_PROJECT}/release/abort`);
    expect(abortResp.status()).toBe(200);

    const releaseJob = await waitForJobCompletion(request, releaseBody.release_job_id, 10_000);
    expect(releaseJob, 'release job should finish after abort').not.toBeNull();
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3);

    const cancelledRun = await waitForWorkflowRunTerminal(request, runId!, 30_000);

    await expect(page.getByText('final snapshot')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('live · refreshes every 5s')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.locator(`[aria-label="status ${cancelledRun.run.status}"]`).first()).toBeVisible({
      timeout: 15_000,
    });
    if (cancelledRun.steps.some((step) => step.status === 'cancelled')) {
      await expect(page.getByText(/cancelled\s*1/i).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('needs attention')).toBeVisible({ timeout: 15_000 });
    }
    await expect(page).toHaveURL(stableUrl);
  });
});
