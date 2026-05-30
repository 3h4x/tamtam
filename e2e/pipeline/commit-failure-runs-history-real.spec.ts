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

const RUNS_PROJECT = 'commit-failure-runs';
const HISTORY_PROJECT = 'commit-failure-history';
const COMMIT_DELAY_MS = 6500;
const COMMIT_ERROR = 'pre-commit hook rejected staged changes';

async function seedProject(
  request: import('@playwright/test').APIRequestContext,
  project: string,
): Promise<void> {
  writeScenario(project, SCENARIO.steps);
  resetShimState(project);
  writeGitTiming(project, { commit: COMMIT_DELAY_MS });
  writeGitFailures(project, {
    commit: {
      exitCode: 1,
      stderr: `${COMMIT_ERROR}\n`,
    },
  });
  await enableProject(request, project, { testsDisabled: true });
}

test.describe('Real commit failure lifecycle in runs/history lists', () => {
  test('history row flips from running to release failed when the live pipeline dies in commit', async ({
    page,
    request,
  }) => {
    await seedProject(request, RUNS_PROJECT);

    const releaseResp = await request.post(`/api/projects/by-project/${RUNS_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const runningReview = await waitForJobRunning(request, RUNS_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${RUNS_PROJECT}/history`);

    const releaseRow = page.getByRole('button').filter({
      has: page.getByText('Release pipeline'),
    }).first();

    await expect(releaseRow.getByText('release failed')).toBeVisible({ timeout: 40_000 });
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 40_000 });
  });

  test('history tab flips from running to release failed and opens the commit log when the live pipeline dies in commit', async ({
    page,
    request,
  }) => {
    await seedProject(request, HISTORY_PROJECT);

    const releaseResp = await request.post(`/api/projects/by-project/${HISTORY_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const runningReview = await waitForJobRunning(request, HISTORY_PROJECT, 'review', 20_000);
    expect(runningReview, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${HISTORY_PROJECT}/history`);

    const releaseRow = page.getByRole('button').filter({
      has: page.getByText('Release pipeline'),
    }).first();

    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 8_000 });
    await expect(releaseRow.getByText('commit ✗1')).toBeVisible({ timeout: 20_000 });
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 8_000 });
    await expect(releaseRow.getByText('release failed')).toHaveCount(0);

    const result = await waitForPipelineCompletion(request, HISTORY_PROJECT, 90_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(releaseRow.getByText('release failed')).toBeVisible({ timeout: 15_000 });
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });

    const expandButton = releaseRow.getByTitle('Expand steps');
    await expect(expandButton).toBeVisible({ timeout: 8_000 });
    await expandButton.click();

    const commitStep = page.getByText('Commit').last();
    await expect(commitStep).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Code review').last()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('exit 1').last()).toBeVisible({ timeout: 8_000 });

    await commitStep.click();

    await expect(page).toHaveURL(
      new RegExp(`/project/${HISTORY_PROJECT}/terminal\\?job=`),
      { timeout: 8_000 },
    );
    await expect(page.getByText(`Commit failed: ${COMMIT_ERROR}`).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
