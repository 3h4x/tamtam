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
  waitForPipelineCompletion,
} from './helpers';
import { E2E_BASE } from './global-setup';

const SUCCESS_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-long.json'), 'utf-8'),
);
const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-failure.json'), 'utf-8'),
);

const SUCCESS_PROJECT = 'workflow-runs-terminal-concurrent-success';
const FAILURE_PROJECT = 'workflow-runs-terminal-concurrent-failure';
const ACTIVE_PIPELINE_SUMMARY =
  /pipeline summary: (release|test|review|fix|commit|push|dod|merge|soak) running/i;
const DEFAULT_DO_NOT_SHIP_ACTION = 'fix';

let sharedStateLock: PipelineSharedStateLock | null = null;

function workflowRunLink(scope: Locator, project: string): Locator {
  return scope.getByRole('link').filter({ hasText: project }).first();
}

async function startRelease(
  request: import('@playwright/test').APIRequestContext,
  project: string,
): Promise<string> {
  const response = await request.post(`/api/projects/by-project/${encodeURIComponent(project)}/release`);
  expect(
    response.status(),
    `${project} release POST failed: ${await response.text()}`,
  ).toBe(200);

  const body = await response.json() as { release_job_id: string };
  expect(body.release_job_id, `${project} release_job_id in response`).toBeTruthy();
  return body.release_job_id;
}

test.describe('Real workflow-runs and terminal concurrent lifecycle', () => {
  test.beforeEach(async ({ request }) => {
    sharedStateLock = await acquirePipelineSharedStateLock(
      'workflow-runs-terminal-concurrent-real',
    );
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

  test('workflow-runs moves one failed release to attention while an unrelated terminal stays live until its own success', async ({
    page,
    request,
  }) => {
    resetShimState(SUCCESS_PROJECT);
    writeScenario(SUCCESS_PROJECT, SUCCESS_SCENARIO.steps);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    resetShimState(FAILURE_PROJECT);
    writeScenario(FAILURE_PROJECT, FAILURE_SCENARIO.steps);
    await enableProject(request, FAILURE_PROJECT, { testsDisabled: true });

    const terminalPage = await page.context().newPage();

    await page.goto('/workflow-runs');
    await terminalPage.goto(`/project/${SUCCESS_PROJECT}/terminal`);

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(terminalPage.getByText('live run')).toHaveCount(0);

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

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 15_000 });
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toBeVisible({ timeout: 15_000 });
    await expect(workflowRunLink(activePanel, FAILURE_PROJECT)).toBeVisible({ timeout: 15_000 });

    await expect(terminalPage).toHaveURL(
      new RegExp(
        `/project/${SUCCESS_PROJECT}/terminal\\?job=${encodeURIComponent(successReleaseJobId)}`,
      ),
      { timeout: 20_000 },
    );
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(terminalPage.getByLabel(ACTIVE_PIPELINE_SUMMARY)).toBeVisible({
      timeout: 20_000,
    });

    const stableWorkflowRunsUrl = page.url();
    const stableTerminalUrl = terminalPage.url();

    const failureResult = await waitForPipelineCompletion(
      request,
      FAILURE_PROJECT,
      90_000,
      failureReleaseJobId,
    );
    expect(failureResult.status, 'failure pipeline should finish first').toBe('done');
    expect(failureResult.releaseJob?.['exit_code'], 'failure release exit code').not.toBe(0);

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const failureRow = workflowRunLink(attentionPanel, FAILURE_PROJECT);
    await expect(failureRow).toBeVisible({ timeout: 15_000 });
    await expect(failureRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(failureRow.getByText('DO NOT SHIP')).toBeVisible({ timeout: 15_000 });
    await expect(workflowRunLink(activePanel, FAILURE_PROJECT)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(stableWorkflowRunsUrl);

    await expect(terminalPage.getByText('live run')).toBeVisible();
    await expect(terminalPage.getByLabel(ACTIVE_PIPELINE_SUMMARY)).toBeVisible();
    await expect(terminalPage).toHaveURL(stableTerminalUrl);

    const successResult = await waitForPipelineCompletion(
      request,
      SUCCESS_PROJECT,
      90_000,
      successReleaseJobId,
    );
    expect(successResult.status, 'success pipeline should eventually complete').toBe('done');
    expect(successResult.releaseJob?.['exit_code'], 'success release exit code').toBe(0);

    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toHaveCount(0, {
      timeout: 15_000,
    });
    const successRow = page.getByRole('row').filter({ hasText: SUCCESS_PROJECT }).first();
    await expect(successRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(successRow).toContainText(SUCCESS_PROJECT);
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 15_000 });

    await expect(terminalPage.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(terminalPage.getByLabel(/pipeline summary:/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(terminalPage.getByText(/Verdict: LGTM/).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(terminalPage).toHaveURL(stableTerminalUrl);
  });
});
