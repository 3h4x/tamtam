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

const LONG_SUCCESS_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-long.json'), 'utf-8'),
);
const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-failure.json'), 'utf-8'),
);
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);

const SUCCESS_PROJECT = 'workflow-runs-real-success';
const FAILURE_PROJECT = 'workflow-runs-real-failure';
const CANCELLED_PROJECT = 'workflow-runs-real-cancelled';
const DEFAULT_DO_NOT_SHIP_ACTION = 'fix';
let sharedStateLock: PipelineSharedStateLock | null = null;

type WorkflowRunSummary = {
  id: string;
  status: string;
  input: unknown;
  output: unknown;
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

async function startRelease(
  request: APIRequestContext,
  project: string,
): Promise<string> {
  const resp = await request.post(`/api/projects/by-project/${encodeURIComponent(project)}/release`);
  expect(
    resp.status(),
    `${project} release POST failed: ${await resp.text()}`,
  ).toBe(200);

  const body = (await resp.json()) as { release_job_id: string };
  expect(body.release_job_id, `${project} release_job_id in response`).toBeTruthy();
  return body.release_job_id;
}

test.describe('Real workflow-runs concurrent transitions', () => {
  test.beforeEach(async ({ request }) => {
    sharedStateLock = await acquirePipelineSharedStateLock('runs-concurrent-real');
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

  test('one blocked release moves to attention while another stays active, then both settle independently', async ({
    page,
    request,
  }) => {
    resetShimState(SUCCESS_PROJECT);
    writeScenario(SUCCESS_PROJECT, LONG_SUCCESS_SCENARIO.steps);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    resetShimState(FAILURE_PROJECT);
    writeScenario(FAILURE_PROJECT, FAILURE_SCENARIO.steps);
    await enableProject(request, FAILURE_PROJECT, { testsDisabled: true });

    const [successReleaseJobId, failureReleaseJobId] = await Promise.all([
      startRelease(request, SUCCESS_PROJECT),
      startRelease(request, FAILURE_PROJECT),
    ]);

    const [successReview, failureReview] = await Promise.all([
      waitForJobRunning(request, SUCCESS_PROJECT, 'review', 20_000),
      waitForJobRunning(request, FAILURE_PROJECT, 'review', 20_000),
    ]);
    expect(successReview, 'success project review should be running').not.toBeNull();
    expect(failureReview, 'failure project review should be running').not.toBeNull();

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toBeVisible({ timeout: 12_000 });
    await expect(workflowRunLink(activePanel, FAILURE_PROJECT)).toBeVisible({ timeout: 12_000 });

    const failureResult = await waitForPipelineCompletion(
      request,
      FAILURE_PROJECT,
      90_000,
      failureReleaseJobId,
    );
    expect(failureResult.status, 'failure pipeline should finish first').toBe('done');
    expect(failureResult.releaseJob?.['exit_code'], 'failure release exit code').not.toBe(0);

    await waitForWorkflowRunStatus(request, FAILURE_PROJECT, 'completed');

    const failureRow = workflowRunLink(attentionPanel, FAILURE_PROJECT);
    await expect(attentionPanel).toBeVisible({ timeout: 15_000 });
    await expect(failureRow).toBeVisible({ timeout: 15_000 });
    await expect(failureRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(failureRow.getByText('DO NOT SHIP')).toBeVisible({ timeout: 15_000 });
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toBeVisible({ timeout: 15_000 });
    await expect(workflowRunLink(activePanel, FAILURE_PROJECT)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 15_000 });

    const successResult = await waitForPipelineCompletion(
      request,
      SUCCESS_PROJECT,
      90_000,
      successReleaseJobId,
    );
    expect(successResult.status, 'success pipeline should eventually complete').toBe('done');
    expect(successResult.releaseJob?.['exit_code'], 'success release exit code').toBe(0);

    await waitForWorkflowRunStatus(request, SUCCESS_PROJECT, 'completed');

    const successRow = page.getByRole('row').filter({ hasText: SUCCESS_PROJECT }).first();
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(failureRow).toBeVisible();
    await expect(successRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(successRow).toContainText(SUCCESS_PROJECT);
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 15_000 });
  });

  test('one cancelled release moves to attention while another stays active, then the running state clears', async ({
    page,
    request,
  }) => {
    resetShimState(SUCCESS_PROJECT);
    writeScenario(SUCCESS_PROJECT, LONG_SUCCESS_SCENARIO.steps);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    resetShimState(CANCELLED_PROJECT);
    writeScenario(CANCELLED_PROJECT, ABORT_SCENARIO.steps);
    await enableProject(request, CANCELLED_PROJECT, { testsDisabled: true });

    const [successReleaseJobId, cancelReleaseJobId] = await Promise.all([
      startRelease(request, SUCCESS_PROJECT),
      startRelease(request, CANCELLED_PROJECT),
    ]);

    const [successReview, cancelReview] = await Promise.all([
      waitForJobRunning(request, SUCCESS_PROJECT, 'review', 20_000),
      waitForJobRunning(request, CANCELLED_PROJECT, 'review', 20_000),
    ]);
    expect(successReview, 'success project review should be running').not.toBeNull();
    expect(cancelReview, 'cancel project review should be running').not.toBeNull();

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toBeVisible({ timeout: 12_000 });
    await expect(workflowRunLink(activePanel, CANCELLED_PROJECT)).toBeVisible({
      timeout: 12_000,
    });

    const abortResp = await request.post(
      `/api/projects/by-project/${encodeURIComponent(CANCELLED_PROJECT)}/release/abort`,
    );
    expect(abortResp.status()).toBe(200);

    const cancelledRelease = await waitForJobCompletion(request, cancelReleaseJobId, 15_000);
    expect(cancelledRelease, 'cancelled release job should finish after abort').not.toBeNull();
    expect(cancelledRelease?.['exit_code'], 'cancelled release exit code').toBe(-3);

    await waitForWorkflowRunStatus(request, CANCELLED_PROJECT, 'completed');

    const cancelledRow = workflowRunLink(attentionPanel, CANCELLED_PROJECT);
    await expect(attentionPanel).toBeVisible({ timeout: 15_000 });
    await expect(cancelledRow).toBeVisible({ timeout: 15_000 });
    await expect(cancelledRow.getByLabel('status completed')).toBeVisible({
      timeout: 15_000,
    });
    await expect(cancelledRow.locator('[title="cancelled"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(cancelledRow.getByText('exit -3')).toHaveCount(0);
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toBeVisible({ timeout: 15_000 });
    await expect(workflowRunLink(activePanel, CANCELLED_PROJECT)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 15_000 });

    const successResult = await waitForPipelineCompletion(
      request,
      SUCCESS_PROJECT,
      90_000,
      successReleaseJobId,
    );
    expect(successResult.status, 'success pipeline should eventually complete').toBe('done');
    expect(successResult.releaseJob?.['exit_code'], 'success release exit code').toBe(0);

    await waitForWorkflowRunStatus(request, SUCCESS_PROJECT, 'completed');

    const successRow = page.getByRole('row').filter({ hasText: SUCCESS_PROJECT }).first();
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(cancelledRow).toBeVisible();
    await expect(successRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(successRow).toContainText(SUCCESS_PROJECT);
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 15_000 });
  });
});
