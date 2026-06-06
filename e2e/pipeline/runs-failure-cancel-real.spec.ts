import { test, expect } from '@playwright/test';
import type { APIRequestContext, Locator } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  acquirePipelineSharedStateLock,
  type PipelineSharedStateLock,
  writeScenario,
  resetShimState,
  enableProject,
  waitForJobRunning,
  waitForPipelineCompletion,
  waitForJobCompletion,
} from './helpers';
import { E2E_BASE } from './global-setup';

const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-failure.json'), 'utf-8'),
);
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);

const FAILURE_PROJECT = 'workflow-runs-real-dns';
const CANCELLED_PROJECT = 'workflow-runs-real-abort';
const LONG_FAILURE_STEPS = FAILURE_SCENARIO.steps.map((step: { label?: string; sleep_ms?: number; text: string }) =>
  step.label === 'review' ? { ...step, sleep_ms: 20_000 } : step,
);
const LONG_ABORT_STEPS = ABORT_SCENARIO.steps.map((step: { label?: string; sleep_ms?: number; text: string }) =>
  step.label === 'review' ? { ...step, sleep_ms: 60_000 } : step,
);
const DEFAULT_DO_NOT_SHIP_ACTION = 'fix';
let sharedStateLock: PipelineSharedStateLock | null = null;

type WorkflowRunSummary = {
  id: string;
  status: string;
  input: unknown;
  error: string | null;
};

function workflowRunForProject(
  runs: WorkflowRunSummary[],
  project: string,
): WorkflowRunSummary | undefined {
  return runs.find((run) => Array.isArray(run.input) && run.input[0] === project);
}

async function waitForWorkflowRunStatus(
  request: APIRequestContext,
  project: string,
  status: string,
  timeoutMs = 30_000,
): Promise<WorkflowRunSummary> {
  const deadline = Date.now() + timeoutMs;
  let lastRun: WorkflowRunSummary | undefined;
  while (Date.now() < deadline) {
    const resp = await request.get('/api/workflow-runs?limit=100');
    if (resp.ok()) {
      const body = (await resp.json()) as { runs?: WorkflowRunSummary[] };
      lastRun = workflowRunForProject(body.runs ?? [], project);
      if (lastRun?.status === status) return lastRun;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Timed out waiting for workflow run ${project} to reach ${status}; last status was ${lastRun?.status ?? 'missing'}`,
  );
}

function workflowRunLink(panel: Locator, project: string): Locator {
  return panel.getByRole('link').filter({ hasText: project }).first();
}

test.describe('Real workflow-runs failure and cancellation transitions', () => {
  test.beforeEach(async ({ request }) => {
    sharedStateLock = await acquirePipelineSharedStateLock('runs-failure-cancel-real');
    rmSync(join(E2E_BASE, 'workflow-data'), { recursive: true, force: true });
    mkdirSync(join(E2E_BASE, 'workflow-data', 'runs'), { recursive: true });
    mkdirSync(join(E2E_BASE, 'workflow-data', 'steps'), { recursive: true });

    const patch = await request.patch('/api/settings', {
      data: { review_do_not_ship_action: 'abort' },
    });
    expect(
      patch.ok(),
      `failed to set review_do_not_ship_action: ${patch.status()}`,
    ).toBe(true);
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

  test('failed release leaves the active panel and appears in attention with its project and error text', async ({
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

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 15_000 });
    await expect(workflowRunLink(activePanel, FAILURE_PROJECT)).toBeVisible({ timeout: 15_000 });

    const runningReview = await waitForJobRunning(request, FAILURE_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    const result = await waitForPipelineCompletion(request, FAILURE_PROJECT, 90_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    const failedRun = await waitForWorkflowRunStatus(request, FAILURE_PROJECT, 'completed');

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const failureRow = workflowRunLink(attentionPanel, FAILURE_PROJECT);
    await expect(attentionPanel).toBeVisible({ timeout: 15_000 });
    await expect(failureRow).toBeVisible({ timeout: 15_000 });
    await expect(failureRow.getByLabel('status completed')).toBeVisible();
    await expect(failureRow.getByText('DO NOT SHIP')).toBeVisible();
    await expect(failureRow.getByText(/critical security vulnerabilities/i)).toBeVisible();
    await expect(page.getByText('1 recent', { exact: true })).toBeVisible();
    expect(failedRun.status).toBe('completed');
    await expect(workflowRunLink(activePanel, FAILURE_PROJECT)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: /completed \d+/i })).toBeVisible();
  });

  test('cancelled release leaves the active panel and appears in attention with its project and exit code', async ({
    page,
    request,
  }) => {
    writeScenario(CANCELLED_PROJECT, LONG_ABORT_STEPS);
    resetShimState(CANCELLED_PROJECT);
    await enableProject(request, CANCELLED_PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${CANCELLED_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 15_000 });
    await expect(workflowRunLink(activePanel, CANCELLED_PROJECT)).toBeVisible({ timeout: 15_000 });

    const runningReview = await waitForJobRunning(request, CANCELLED_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    const abortResp = await request.post(`/api/projects/by-project/${CANCELLED_PROJECT}/release/abort`);
    expect(abortResp.status()).toBe(200);

    const releaseJob = await waitForJobCompletion(request, releaseBody.release_job_id, 10_000);
    expect(releaseJob, 'release job should finish after abort').not.toBeNull();
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3);

    await waitForWorkflowRunStatus(request, CANCELLED_PROJECT, 'completed');

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const cancelledRow = workflowRunLink(attentionPanel, CANCELLED_PROJECT);
    await expect(attentionPanel).toBeVisible({ timeout: 15_000 });
    await expect(cancelledRow).toBeVisible({ timeout: 15_000 });
    await expect(cancelledRow.getByLabel('status completed')).toBeVisible();
    await expect(cancelledRow.getByText('exit -3')).toBeVisible();
    await expect(page.getByText('1 recent', { exact: true })).toBeVisible();
    await expect(workflowRunLink(activePanel, CANCELLED_PROJECT)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: /completed \d+/i })).toBeVisible();
  });
});
