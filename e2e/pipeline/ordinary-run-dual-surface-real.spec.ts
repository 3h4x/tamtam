import { test, expect } from '@playwright/test';
import {
  enableProject,
  resetShimState,
  waitForJobByIdRunning,
  waitForJobCompletion,
  writeScenario,
} from './helpers';

const SUCCESS_PROJECT = 'run-dual-surface-real-success';
const CANCELLED_PROJECT = 'run-dual-surface-real-cancelled';

test.describe('Real ordinary run dual-surface lifecycle', () => {
  test('history and terminal both reflect a live ordinary run, then settle to success without reload', async ({
    page,
    request,
  }) => {
    resetShimState(SUCCESS_PROJECT);
    writeScenario(SUCCESS_PROJECT, [
      {
        label: 'run',
        sleep_ms: 3000,
        text: 'Real dual-surface ordinary run completed successfully.',
      },
    ]);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    await page.goto(`/project/${SUCCESS_PROJECT}/history`);
    await expect(page.getByText('No runs yet').first()).toBeVisible({ timeout: 8_000 });

    const runResp = await request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/run`, {
      data: { prompt: 'Watch this ordinary run on history and terminal together.' },
    });
    expect(runResp.status(), `run POST failed: ${await runResp.text()}`).toBe(200);

    const runBody = await runResp.json() as { job_id: string };
    expect(runBody.job_id, 'run job_id in response').toBeTruthy();

    const runningRun = await waitForJobByIdRunning(request, runBody.job_id, 20_000);
    expect(runningRun, 'ordinary run should be running').not.toBeNull();

    const runRow = page.getByRole('button').filter({
      hasText: 'Watch this ordinary run on history and terminal together.',
    }).first();

    await expect(runRow).toBeVisible({ timeout: 20_000 });
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No runs yet')).toHaveCount(0, { timeout: 20_000 });

    const terminalPage = await page.context().newPage();
    await terminalPage.goto(
      `/project/${SUCCESS_PROJECT}/terminal?job=${encodeURIComponent(runBody.job_id)}`,
    );

    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(
      terminalPage.getByText('Watch this ordinary run on history and terminal together.'),
    ).toBeVisible({ timeout: 20_000 });

    const runJob = await waitForJobCompletion(request, runBody.job_id, 60_000);
    expect(runJob?.['exit_code'], 'run exit code').toBe(0);

    await expect(runRow.getByLabel('done')).toBeVisible({ timeout: 15_000 });
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });

    await expect(terminalPage.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
  });

  test('history and terminal both clear the live state when an ordinary run is cancelled mid-flight', async ({
    page,
    request,
  }) => {
    resetShimState(CANCELLED_PROJECT);
    writeScenario(CANCELLED_PROJECT, [
      {
        label: 'run',
        sleep_ms: 10000,
        text: 'This dual-surface run should be cancelled before completion.',
      },
    ]);
    await enableProject(request, CANCELLED_PROJECT, { testsDisabled: true });

    await page.goto(`/project/${CANCELLED_PROJECT}/history`);
    await expect(page.getByText('No runs yet').first()).toBeVisible({ timeout: 8_000 });

    const runResp = await request.post(`/api/projects/by-project/${CANCELLED_PROJECT}/run`, {
      data: { prompt: 'Cancel this ordinary dual-surface run before it finishes.' },
    });
    expect(runResp.status(), `run POST failed: ${await runResp.text()}`).toBe(200);

    const runBody = await runResp.json() as { job_id: string };
    expect(runBody.job_id, 'run job_id in response').toBeTruthy();

    const runningRun = await waitForJobByIdRunning(request, runBody.job_id, 20_000);
    expect(runningRun, 'ordinary run should be running before cancellation').not.toBeNull();

    const runRow = page.getByRole('button').filter({
      hasText: 'Cancel this ordinary dual-surface run before it finishes.',
    }).first();

    await expect(runRow).toBeVisible({ timeout: 20_000 });
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No runs yet')).toHaveCount(0, { timeout: 20_000 });

    const terminalPage = await page.context().newPage();
    await terminalPage.goto(
      `/project/${CANCELLED_PROJECT}/terminal?job=${encodeURIComponent(runBody.job_id)}`,
    );
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });

    const cancelResp = await request.delete(`/api/jobs/${encodeURIComponent(runBody.job_id)}`);
    expect(cancelResp.status(), `cancel DELETE failed: ${await cancelResp.text()}`).toBe(200);

    const runJob = await waitForJobCompletion(request, runBody.job_id, 20_000);
    expect(runJob?.['exit_code'], 'cancelled run exit code').toBe(-2);

    await expect(runRow.getByText('cancelled', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(terminalPage.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(terminalPage.getByText('cancelled').first()).toBeVisible({ timeout: 15_000 });
    await expect(terminalPage.getByText('exit 0 — ok')).toHaveCount(0);
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
  });
});
