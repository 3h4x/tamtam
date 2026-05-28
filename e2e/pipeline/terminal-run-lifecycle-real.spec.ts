import { test, expect } from '@playwright/test';
import {
  enableProject,
  resetShimState,
  waitForJobByIdRunning,
  waitForJobCompletion,
  writeScenario,
} from './helpers';

const SUCCESS_PROJECT = 'terminal-run-success';
const CANCEL_PROJECT = 'terminal-run-cancel';

test.describe('Terminal run lifecycle', () => {
  test('ordinary run session clears its live badge and shows exit 0 after success', async ({
    page,
    request,
  }) => {
    resetShimState(SUCCESS_PROJECT);
    writeScenario(SUCCESS_PROJECT, [
      {
        label: 'run',
        sleep_ms: 3000,
        text: 'Run completed successfully.',
      },
    ]);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    const runResp = await request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/run`, {
      data: { prompt: 'Check the ordinary terminal run lifecycle.' },
    });
    expect(runResp.status(), `run POST failed: ${await runResp.text()}`).toBe(200);

    const runBody = await runResp.json() as { job_id: string };
    expect(runBody.job_id, 'run job_id in response').toBeTruthy();

    const runningRun = await waitForJobByIdRunning(request, runBody.job_id, 20_000);
    expect(runningRun, 'terminal run should be running').not.toBeNull();

    await page.goto(`/project/${SUCCESS_PROJECT}/terminal?job=${encodeURIComponent(runBody.job_id)}`);

    await expect(page).toHaveURL(new RegExp(`/project/${SUCCESS_PROJECT}/terminal/`), {
      timeout: 20_000,
    });
    await expect(page.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Check the ordinary terminal run lifecycle.')).toBeVisible({
      timeout: 20_000,
    });

    const job = await waitForJobCompletion(request, runBody.job_id, 60_000);
    expect(job?.['exit_code'], 'run exit code').toBe(0);

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('exit 0 — ok').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Run completed successfully.')).toBeVisible({ timeout: 15_000 });
  });

  test('ordinary run session clears its live badge and shows cancelled after operator abort', async ({
    page,
    request,
  }) => {
    resetShimState(CANCEL_PROJECT);
    writeScenario(CANCEL_PROJECT, [
      {
        label: 'run',
        sleep_ms: 10000,
        text: 'This line should not win the race with cancellation.',
      },
    ]);
    await enableProject(request, CANCEL_PROJECT, { testsDisabled: true });

    const runResp = await request.post(`/api/projects/by-project/${CANCEL_PROJECT}/run`, {
      data: { prompt: 'Cancel this ordinary terminal run.' },
    });
    expect(runResp.status(), `run POST failed: ${await runResp.text()}`).toBe(200);

    const runBody = await runResp.json() as { job_id: string };
    expect(runBody.job_id, 'run job_id in response').toBeTruthy();

    const runningRun = await waitForJobByIdRunning(request, runBody.job_id, 20_000);
    expect(runningRun, 'terminal run should be running before cancellation').not.toBeNull();

    await page.goto(`/project/${CANCEL_PROJECT}/terminal?job=${encodeURIComponent(runBody.job_id)}`);

    await expect(page).toHaveURL(new RegExp(`/project/${CANCEL_PROJECT}/terminal/`), {
      timeout: 20_000,
    });
    await expect(page.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Cancel this ordinary terminal run.')).toBeVisible({
      timeout: 20_000,
    });

    const cancelResp = await request.delete(`/api/jobs/${encodeURIComponent(runBody.job_id)}`);
    expect(cancelResp.status(), `cancel DELETE failed: ${await cancelResp.text()}`).toBe(200);

    const job = await waitForJobCompletion(request, runBody.job_id, 20_000);
    expect(job?.['exit_code'], 'cancelled run exit code').toBe(-2);

    await expect(page.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('cancelled').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('exit 0 — ok')).toHaveCount(0);
  });
});
