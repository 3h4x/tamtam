import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  writeGitTiming,
  writeGitFailures,
  enableProject,
  waitForPipelineCompletion,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'ui-live-transition.json'), 'utf-8'),
);

const TERMINAL_PROJECT = 'commit-failure-live';
const TRACE_PROJECT = 'commit-failure-trace';
const COMMIT_DELAY_MS = 6500;
const COMMIT_ERROR = 'pre-commit hook rejected staged changes';

test.describe('Real commit failure lifecycle', () => {
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

  test('terminal strip reaches commit, disappears on failure, and leaves the commit error visible', async ({
    page,
    request,
  }) => {
    await seedProject(request, TERMINAL_PROJECT);

    const releaseResp = await request.post(`/api/projects/by-project/${TERMINAL_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    await page.goto(`/project/${TERMINAL_PROJECT}/terminal?job=${encodeURIComponent(releaseBody.release_job_id)}`);

    await expect(page.getByLabel(/pipeline summary: review running/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByLabel(/pipeline summary: commit running/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByLabel(/commit: running\./i)).toBeVisible({ timeout: 30_000 });

    const result = await waitForPipelineCompletion(request, TERMINAL_PROJECT, 90_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(page.getByLabel(/pipeline summary:/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'abort' })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(`Commit failed: ${COMMIT_ERROR}`).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('release trace flips from running to failed and exposes the commit error excerpt', async ({
    page,
    request,
  }) => {
    await seedProject(request, TRACE_PROJECT);

    const releaseResp = await request.post(`/api/projects/by-project/${TRACE_PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    expect(releaseBody.release_job_id, 'release_job_id in response').toBeTruthy();

    await page.goto(
      `/project/${TRACE_PROJECT}/release/${encodeURIComponent(releaseBody.release_job_id)}`,
    );

    await expect(page.getByText('running').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('commit').first()).toBeVisible({ timeout: 40_000 });

    const result = await waitForPipelineCompletion(request, TRACE_PROJECT, 90_000);
    expect(result.status, 'pipeline should finish').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should fail with non-zero exit').not.toBe(0);

    await expect(page.getByText('failed').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('running', { exact: true })).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('running…')).toHaveCount(0, { timeout: 15_000 });

    await page.getByRole('button', { name: /commit/i }).first().click();
    await expect(page.getByText(`Commit failed: ${COMMIT_ERROR}`).first()).toBeVisible({
      timeout: 8_000,
    });
  });
});
