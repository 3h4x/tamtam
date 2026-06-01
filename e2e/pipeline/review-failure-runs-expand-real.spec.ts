import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
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

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-failure.json'), 'utf-8'),
);

const PROJECT = 'review-failure-runs-expand';
const DEFAULT_DO_NOT_SHIP_ACTION = 'fix';
let sharedStateLock: PipelineSharedStateLock | null = null;

test.describe('Real review failure drill-in from project history', () => {
  test.beforeEach(async () => {
    sharedStateLock = await acquirePipelineSharedStateLock('review-failure-runs-expand-real');
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

  test('failed review expands into nested steps and opens the review findings from project history without reload', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });
    const patch = await request.patch('/api/settings', {
      data: { review_do_not_ship_action: 'abort' },
    });
    expect(
      patch.ok(),
      `failed to set review_do_not_ship_action: ${patch.status()}`,
    ).toBe(true);

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

    const result = await waitForPipelineCompletion(request, PROJECT, 30_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(releaseRow.getByText('cancelled after review')).toBeVisible({ timeout: 15_000 });
    await expect(releaseRow.getByText(/critical security vulnerabilities/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, {
      timeout: 15_000,
    });

    const expandButton = releaseRow.getByTitle('Expand steps');
    await expect(expandButton).toBeVisible({ timeout: 8_000 });
    await expandButton.click();

    const reviewStep = page.getByText('Code review').last();
    await expect(reviewStep).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('✗ DNS').last()).toBeVisible({ timeout: 8_000 });

    await reviewStep.click();

    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal\\?job=`),
      { timeout: 8_000 },
    );
    await expect(page.getByText(/critical security vulnerabilities/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/DO NOT SHIP/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
