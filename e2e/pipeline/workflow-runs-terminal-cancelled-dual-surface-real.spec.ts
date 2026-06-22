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
} from './helpers';
import { E2E_BASE } from './global-setup';

const BASE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);

const PROJECT = 'workflow-runs-terminal-cancelled-dual-surface';
const STEPS = BASE_SCENARIO.steps.map(
  (step: { label?: string; sleep_ms?: number; text: string }) =>
    step.label === 'review' ? { ...step, sleep_ms: 10_000 } : step,
);
const ACTIVE_PIPELINE_SUMMARY =
  /pipeline summary: (release|test|review|fix|commit|push|dod|merge|soak) running/i;

let sharedStateLock: PipelineSharedStateLock | null = null;

function workflowRunLink(scope: Locator, project: string): Locator {
  return scope.getByRole('link').filter({ hasText: project }).first();
}

test.describe('Real workflow-runs and terminal dual-surface abort lifecycle', () => {
  test.beforeEach(async () => {
    sharedStateLock = await acquirePipelineSharedStateLock(
      'workflow-runs-terminal-cancelled-dual-surface',
    );
    rmSync(join(E2E_BASE, 'workflow-data'), { recursive: true, force: true });
    mkdirSync(join(E2E_BASE, 'workflow-data', 'runs'), { recursive: true });
    mkdirSync(join(E2E_BASE, 'workflow-data', 'steps'), { recursive: true });
  });

  test.afterEach(() => {
    sharedStateLock?.release();
    sharedStateLock = null;
  });

  test('externally-started release appears live on workflow-runs and terminal, then settles to attention/cancelled on both surfaces without reload', async ({
    page,
    request,
  }) => {
    resetShimState(PROJECT);
    writeScenario(PROJECT, STEPS);
    await enableProject(request, PROJECT, { testsDisabled: true });

    const terminalPage = await page.context().newPage();

    await page.goto('/workflow-runs');
    await terminalPage.goto(`/project/${PROJECT}/terminal`);

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('No workflow runs yet')).toBeVisible({ timeout: 8_000 });
    await expect(terminalPage.getByRole('button', { name: 'new' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(terminalPage.getByText('live run')).toHaveCount(0);

    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    const runningReview = await waitForJobRunning(request, PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    const activePanel = page.getByLabel('Active workflow runs');
    const activeRun = workflowRunLink(activePanel, PROJECT);
    await expect(activePanel).toBeVisible({ timeout: 15_000 });
    await expect(activeRun).toBeVisible({ timeout: 15_000 });
    await expect(activeRun.getByLabel('status running')).toBeVisible({ timeout: 15_000 });

    await expect(terminalPage).toHaveURL(
      new RegExp(
        `/project/${PROJECT}/terminal\\?job=${encodeURIComponent(releaseBody.release_job_id)}`,
      ),
      { timeout: 20_000 },
    );
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(terminalPage.getByLabel(ACTIVE_PIPELINE_SUMMARY)).toBeVisible({
      timeout: 20_000,
    });

    const stableWorkflowRunsUrl = page.url();
    const stableTerminalUrl = terminalPage.url();

    const abortResp = await request.post(`/api/projects/by-project/${PROJECT}/release/abort`);
    expect(abortResp.status()).toBe(200);

    const releaseJob = await waitForJobCompletion(request, releaseBody.release_job_id, 15_000);
    expect(releaseJob, 'release job should finish after abort').not.toBeNull();
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3);

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const cancelledRow = workflowRunLink(attentionPanel, PROJECT);
    await expect(activeRun).toHaveCount(0, { timeout: 15_000 });
    await expect(cancelledRow).toBeVisible({ timeout: 15_000 });
    await expect(cancelledRow.getByLabel('status completed')).toBeVisible({ timeout: 15_000 });
    await expect(cancelledRow.locator('[title="cancelled"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(cancelledRow.getByText('exit -3')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /completed 1/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 15_000 });
    await expect(page).toHaveURL(stableWorkflowRunsUrl);

    await expect(terminalPage.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(terminalPage.getByLabel(/pipeline summary:/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(terminalPage.getByText('cancelled').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(terminalPage.getByText('exit -3')).toHaveCount(0);
    await expect(terminalPage).toHaveURL(stableTerminalUrl);
  });
});
