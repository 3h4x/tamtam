import { test, expect } from '@playwright/test';
import {
  enableProject,
  resetShimState,
  waitForJobByIdRunning,
  waitForJobCompletion,
  writeScenario,
} from './helpers';

const PROJECT = 'runs-same-project-real';

test.describe('Real same-project run blocks release lifecycle cleanly', () => {
  test('ordinary run keeps the overview and terminal live while the same project rejects a release attempt', async ({
    page,
    request,
  }) => {
    resetShimState(PROJECT);
    writeScenario(PROJECT, [
      {
        label: 'run',
        sleep_ms: 8_000,
        text: 'Ordinary run finished after the blocked release attempt.',
      },
    ]);
    await enableProject(request, PROJECT, { testsDisabled: true });

    const runResp = await request.post(`/api/projects/by-project/${PROJECT}/run`, {
      data: { prompt: 'Keep this ordinary run busy while the release ships.' },
    });
    expect(runResp.status(), `run POST failed: ${await runResp.text()}`).toBe(200);

    const runBody = await runResp.json() as { job_id: string };
    expect(runBody.job_id, 'run job_id in response').toBeTruthy();

    const runningRun = await waitForJobByIdRunning(request, runBody.job_id, 20_000);
    expect(runningRun, 'ordinary run should be running before the release attempt').not.toBeNull();

    await page.goto(`/project/${PROJECT}`);

    const releaseButton = page.getByRole('button', { name: /release/i }).first();
    const stableUrl = page.url();
    await expect(releaseButton).toBeVisible({ timeout: 8_000 });
    await expect(releaseButton).toBeEnabled();
    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /Terminal, 1 running/i })).toBeVisible({
      timeout: 8_000,
    });

    const blockedRelease = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      blockedRelease.status(),
      `release should be blocked while the run is live: ${await blockedRelease.text()}`,
    ).toBe(409);
    await expect(releaseButton).toBeVisible({ timeout: 8_000 });
    await expect(releaseButton).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Releasing…', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(stableUrl);
    await expect(page.getByText('1 running now')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: /Terminal, 1 running/i })).toBeVisible({
      timeout: 8_000,
    });

    await page.goto(`/project/${PROJECT}/terminal?job=${encodeURIComponent(runBody.job_id)}`);

    await expect(page).toHaveURL(new RegExp(`/project/${PROJECT}/terminal\\?job=`), {
      timeout: 20_000,
    });
    await expect(page.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Keep this ordinary run busy while the release ships.')).toBeVisible({
      timeout: 20_000,
    });

    const runJob = await waitForJobCompletion(request, runBody.job_id, 30_000);
    expect(runJob?.['exit_code'], 'ordinary run exit code').toBe(0);

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Ordinary run finished after the blocked release attempt.')).toBeVisible({
      timeout: 15_000,
    });
  });
});
