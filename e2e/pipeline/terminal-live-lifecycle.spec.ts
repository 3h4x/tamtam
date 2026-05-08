import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  enableProject,
  waitForJobRunning,
  waitForPipelineCompletion,
  waitForJobCompletion,
} from './helpers';

const UI_LIVE_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);
const ABORT_SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);

test.describe('Terminal live lifecycle', () => {
  test('terminal tab clears its live state in place when a release finishes', async ({
    page,
    request,
  }) => {
    const project = 'ui-live';

    writeScenario(project, UI_LIVE_SCENARIO.steps);
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

    const reviewJob = await waitForJobRunning(request, project, 'review', 20_000);
    expect(reviewJob, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${project}/terminal?job=${encodeURIComponent(releaseJobId)}`);

    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible({
      timeout: 8_000,
    });

    const stableUrl = page.url();

    const result = await waitForPipelineCompletion(request, project, 90_000);
    expect(result.status, 'pipeline should complete').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTitle('review in progress — click to open terminal'),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(/Verdict: LGTM/).first()).toBeVisible({ timeout: 8_000 });
    await expect(page).toHaveURL(stableUrl);
  });

  test('aborting a live release clears the terminal spinner and shows cancelled history state', async ({
    page,
    request,
  }) => {
    const project = 'abort';

    writeScenario(project, ABORT_SCENARIO.steps);
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

    const reviewJob = await waitForJobRunning(request, project, 'review', 20_000);
    expect(reviewJob, 'review job should be running').not.toBeNull();

    await page.goto(`/project/${project}/terminal?job=${encodeURIComponent(releaseJobId)}`);

    await expect(page.getByText('live run')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTitle('review in progress — click to open terminal')).toBeVisible({
      timeout: 8_000,
    });

    const abortResp = await request.post(`/api/projects/by-project/${project}/release/abort`);
    expect(abortResp.status()).toBe(200);

    const releaseJob = await waitForJobCompletion(request, releaseJobId, 10_000);
    expect(releaseJob, 'release job should finish after abort').not.toBeNull();
    expect(releaseJob?.['exit_code'], 'release exit code after abort').toBe(-3);

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTitle('review in progress — click to open terminal'),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('exit -3')).toHaveCount(0);

    await page.goto(`/project/${project}/history`);
    await expect(page.getByText(/cancelled/i).first()).toBeVisible({ timeout: 8_000 });
  });
});
