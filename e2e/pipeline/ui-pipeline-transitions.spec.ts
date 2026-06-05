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

// Real pipeline e2e test that also exercises the browser UI.
// The scenario includes a 3 s sleep so the browser can observe the "running"
// state in the history tab before the review job completes.

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);

const PROJECT = 'ui-live';

test.describe('Live pipeline UI transitions', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });
  });

  test('history tab shows running badge then done badge as pipeline executes without reload', async ({
    page,
    request,
  }) => {
    // Trigger the release pipeline (review will sleep 3 s before completing).
    const releaseResp = await request.post(
      `/api/projects/by-project/${PROJECT}/release`,
    );
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    // Wait (via API) until the review job is actively running, then navigate
    // to the history page. Navigating after the job starts means the page
    // loads with an already-running job — no race with the initial poll.
    const runningJob = await waitForJobRunning(request, PROJECT, 'review', 20_000);
    expect(runningJob, 'review job should start running').not.toBeNull();

    await page.goto(`/project/${PROJECT}/history`);
    const releaseRow = page.getByRole('button').filter({ hasText: 'Release pipeline' }).first();

    // The page loads fresh data on mount, so the running job should be visible
    // immediately (no wait for a poll cycle).
    await expect(releaseRow.getByLabel('running')).toBeVisible({ timeout: 5_000 });
    const stableUrl = page.url();

    // Wait for the full pipeline to complete (review LGTM → commit → push).
    const result = await waitForPipelineCompletion(request, PROJECT, 90_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    // Let the history poll cycle pick up the completed state in place.
    await expect(releaseRow.getByLabel('running')).toHaveCount(0, { timeout: 12_000 });

    // The release row should show "done" (no verdict on the meta-job itself).
    await expect(releaseRow.getByLabel('done')).toBeVisible({ timeout: 12_000 });
    await expect(page).toHaveURL(stableUrl);
  });

});
