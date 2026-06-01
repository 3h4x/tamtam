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

const BASE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);

const SUCCESS_PROJECT = 'workflow-runs-live-start-real';
const SUCCESS_STEPS = BASE_SCENARIO.steps.map(
  (step: { label?: string; sleep_ms?: number; text: string }) =>
    step.label === 'review' ? { ...step, sleep_ms: 10_000 } : step,
);
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

  test.afterEach(() => {
    sharedStateLock?.release();
    sharedStateLock = null;
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

    const runningReview = await waitForJobRunning(request, SUCCESS_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    const stableUrl = page.url();
    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 12_000 });
    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByLabel('status running').first()).toBeVisible({
      timeout: 12_000,
    });

    const result = await waitForPipelineCompletion(request, SUCCESS_PROJECT, 90_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(workflowRunLink(activePanel, SUCCESS_PROJECT)).toHaveCount(0, { timeout: 15_000 });
    const completedRow = page.getByRole('row').filter({ hasText: SUCCESS_PROJECT }).first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(stableUrl);
  });
});
