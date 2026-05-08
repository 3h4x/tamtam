import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  enableProject,
  waitForJobRunning,
  waitForPipelineCompletion,
} from './helpers';

const FAILURE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-failure.json'), 'utf-8'),
);

// Tests that a review emitting "DO NOT SHIP" cleanly clears the live terminal
// spinner and leaves the failure verdict visible — verifying that no orphaned
// "running" state persists after a failed pipeline step.
test.describe('Terminal failure-path lifecycle', () => {
  test('DO NOT SHIP review clears live spinner and shows verdict text in terminal', async ({
    page,
    request,
  }) => {
    const project = 'review-failure';

    writeScenario(project, FAILURE_SCENARIO.steps);
    resetShimState(project);
    await enableProject(request, project, { testsDisabled: true });

    const releaseResp = await request.post(`/api/projects/by-project/${project}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    const releaseJobId = releaseBody.release_job_id;
    expect(releaseJobId, 'release_job_id in response').toBeTruthy();

    // Wait until the review job is actively running before navigating.
    const reviewJob = await waitForJobRunning(request, project, 'review', 20_000);
    expect(reviewJob, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${project}/terminal?job=${encodeURIComponent(releaseJobId)}`);

    // Phase 1: live spinner and pipeline strip indicator must be visible while
    // the review is running (shim sleeps 3 s to give us this window).
    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible({
      timeout: 8_000,
    });

    // Wait for the pipeline to finish — review exits with DO NOT SHIP so the
    // release finalises with a non-zero exit code.
    const result = await waitForPipelineCompletion(request, project, 30_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    // Phase 2: live spinner must clear — no orphaned "live run" badge or
    // "review in progress" indicator should remain after the job finishes.
    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTitle('review in progress — click to open terminal'),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('exit 1').first()).toBeVisible({ timeout: 8_000 });

    // Phase 3: the terminal should render the Claude output that caused the
    // failure, including the DO NOT SHIP verdict line.
    await expect(page.getByText(/DO NOT SHIP/).first()).toBeVisible({ timeout: 8_000 });

    // Phase 4: history tab shows a failure badge for the release/review.
    await page.goto(`/project/${project}/history`);
    // The release row summarises the pipeline outcome as "release failed".
    // The nested review step shows "DO NOT SHIP".
    await expect(page.getByText('release failed').first()).toBeVisible({ timeout: 8_000 });
  });
});
