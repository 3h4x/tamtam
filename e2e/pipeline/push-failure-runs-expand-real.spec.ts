import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  writeGitTiming,
  writeGitFailures,
  enableProject,
  waitForJobRunning,
  waitForPipelineCompletion,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);

const PROJECT = 'push-failure-runs-expand';
const PUSH_DELAY_MS = 6500;
const PUSH_ERROR = 'rejected by remote hook';

test.describe('Real push failure drill-in from project history', () => {
  test('cancelled-after-fix release expands into nested steps and opens the push log from project history without reload', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    writeGitTiming(PROJECT, { push: PUSH_DELAY_MS });
    writeGitFailures(PROJECT, {
      push: {
        exitCode: 1,
        stderr: `${PUSH_ERROR}\n`,
      },
    });
    await enableProject(request, PROJECT, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const runningReview = await waitForJobRunning(request, PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${PROJECT}/history`);

    const releaseRow = page.getByRole('button').filter({
      has: page.getByText('Release pipeline'),
    }).first();

    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 8_000 });

    const result = await waitForPipelineCompletion(request, PROJECT, 90_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(releaseRow.getByText('cancelled after fix')).toBeVisible({ timeout: 15_000 });
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(releaseRow.getByRole('button', { name: 'Continue release' })).toBeVisible({
      timeout: 15_000,
    });

    const expandButton = releaseRow.getByTitle('Expand steps');
    await expect(expandButton).toBeVisible({ timeout: 8_000 });
    await expandButton.click();

    const pushStep = page.getByText('Push').last();
    await expect(pushStep).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Code review').last()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('exit 1').last()).toBeVisible({ timeout: 8_000 });

    await pushStep.click();

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=`),
      { timeout: 8_000 },
    );
    await expect(page.getByText(`Push failed: ${PUSH_ERROR}`).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
