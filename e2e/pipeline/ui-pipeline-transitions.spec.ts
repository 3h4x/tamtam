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

  test('history tab shows running badge then done badge as pipeline executes', async ({
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

    // The page loads fresh data on mount, so the running job should be visible
    // immediately (no wait for a poll cycle).
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 5_000 });

    // Wait for the full pipeline to complete (review LGTM → commit → push).
    const result = await waitForPipelineCompletion(request, PROJECT, 90_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    // Reload the page to force a fresh fetch — more reliable than waiting for
    // the 5 s polling cycle to happen to fire after the pipeline completed.
    await page.reload();

    // After the reload, the release job is done, so "running" should not appear.
    // Use { exact: true } to avoid matching the persistent "jobs running" header toggle.
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({ timeout: 5_000 });

    // The release row should show "done" (no verdict on the meta-job itself).
    await expect(page.getByText('done').first()).toBeVisible({ timeout: 5_000 });
  });

});
