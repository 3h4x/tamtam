import { test, expect } from '@playwright/test';
import {
  captureReactKeyWarnings,
  makeWorkflowRun,
  stubWorkflowRuns,
  stubWorkflowRunsShell,
} from './live-update-ui-fixtures';

test.describe('Workflow runs page live polling', () => {
  test('/workflow-runs shows independent active runs across projects and isolates one completion', async ({
    page,
  }) => {
    const reactKeyWarnings = captureReactKeyWarnings(page);
    const alpha = 'workflow-alpha-project';
    const beta = 'workflow-beta-project';
    let phase: 'both-running' | 'alpha-completed' = 'both-running';

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () =>
      phase === 'both-running'
        ? [
            makeWorkflowRun(alpha, 'running'),
            makeWorkflowRun(beta, 'running'),
          ]
        : [
            makeWorkflowRun(alpha, 'completed', { output: { verdict: 'LGTM' } }),
            makeWorkflowRun(beta, 'running'),
          ],
    );

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByText('2 runs')).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByRole('link', { name: new RegExp(alpha, 'i') })).toBeVisible({
      timeout: 8_000,
    });
    await expect(activePanel.getByRole('link', { name: new RegExp(beta, 'i') })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText('2 running')).toBeVisible({ timeout: 8_000 });

    await page.getByRole('button', { name: /running 2/i }).click();
    await expect(page.getByRole('row').filter({ hasText: /release orchestrator/i })).toHaveCount(2);

    phase = 'alpha-completed';

    await expect(activePanel.getByText('1 run')).toBeVisible({ timeout: 12_000 });
    await expect(activePanel.getByRole('link', { name: new RegExp(alpha, 'i') })).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(activePanel.getByRole('link', { name: new RegExp(beta, 'i') })).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 12_000 });

    await page.getByRole('button', { name: /all \d+/i }).click();

    const completedRow = page.getByRole('row').filter({ hasText: alpha }).first();
    await expect(completedRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(completedRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    expect(reactKeyWarnings).toEqual([]);
  });

  test('/workflow-runs transitions running runs to completed, failed, and cancelled without reload', async ({
    page,
  }) => {
    const doneProject = 'workflow-runs-poll-done';
    const failedProject = 'workflow-runs-poll-failed';
    const cancelledProject = 'workflow-runs-poll-cancelled';
    const failureReason = 'Push failed because the remote hook rejected the branch.';
    let terminal = false;

    await stubWorkflowRunsShell(page);
    await stubWorkflowRuns(page, () => [
      terminal
        ? makeWorkflowRun(doneProject, 'completed', { output: { verdict: 'LGTM' } })
        : makeWorkflowRun(doneProject, 'running'),
      terminal
        ? makeWorkflowRun(failedProject, 'failed', { error: failureReason })
        : makeWorkflowRun(failedProject, 'running'),
      terminal
        ? makeWorkflowRun(cancelledProject, 'cancelled', {
            error: 'release was cancelled before completion',
          })
        : makeWorkflowRun(cancelledProject, 'running'),
    ]);

    await page.goto('/workflow-runs');

    const activePanel = page.getByLabel('Active workflow runs');
    await expect(activePanel).toBeVisible({ timeout: 8_000 });
    await expect(activePanel.getByText('3 runs')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('3 running')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /failed 1/i })).toHaveCount(0);

    terminal = true;

    const attentionPanel = page.getByLabel('Workflow runs needing attention');
    const doneRow = page.getByRole('row').filter({ hasText: doneProject }).first();
    const failedRow = attentionPanel.getByRole('link', { name: new RegExp(failedProject, 'i') }).first();
    const cancelledRow = attentionPanel.getByRole('link', { name: new RegExp(cancelledProject, 'i') }).first();

    await expect(activePanel).toHaveCount(0, { timeout: 12_000 });
    await expect(doneRow.getByLabel('status completed')).toBeVisible({ timeout: 12_000 });
    await expect(doneRow.getByText('LGTM')).toBeVisible({ timeout: 12_000 });
    await expect(failedRow.getByLabel('status failed')).toBeVisible({ timeout: 12_000 });
    await expect(failedRow.getByText(failureReason)).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByLabel('status cancelled')).toBeVisible({ timeout: 12_000 });
    await expect(cancelledRow.getByText('release was cancelled before completion')).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText('3 running')).toHaveCount(0, { timeout: 12_000 });

    const failedFilter = page.getByRole('button', { name: /failed 1/i });
    await expect(failedFilter).toBeVisible({ timeout: 12_000 });
    await failedFilter.click();
    await expect(failedRow).toBeVisible();
    await expect(doneRow).toHaveCount(0);
    await expect(cancelledRow).toHaveCount(0);
  });
});
