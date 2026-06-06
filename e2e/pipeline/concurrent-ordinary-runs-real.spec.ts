import { test, expect } from '@playwright/test';
import {
  enableProject,
  resetShimState,
  waitForJobByIdRunning,
  waitForJobCompletion,
  writeScenario,
} from './helpers';

const SUCCESS_PROJECT = 'concurrent-runs-real-success';
const CANCELLED_PROJECT = 'concurrent-runs-real-cancelled';

const SUCCESS_PROMPT = 'Keep this ordinary run alive while another project is cancelled.';
const CANCELLED_PROMPT = 'Cancel this ordinary run while the other project keeps streaming.';

function runRow(page: import('@playwright/test').Page, prompt: string) {
  return page.getByRole('button').filter({ hasText: prompt }).first();
}

test.describe('Real concurrent ordinary runs across projects', () => {
  test('one project can cancel while another stays live, and both surfaces settle independently', async ({
    page,
    request,
  }) => {
    resetShimState(SUCCESS_PROJECT);
    writeScenario(SUCCESS_PROJECT, [
      {
        label: 'run',
        sleep_ms: 20_000,
        text: 'The surviving run finished successfully after the other project was cancelled.',
      },
    ]);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    resetShimState(CANCELLED_PROJECT);
    writeScenario(CANCELLED_PROJECT, [
      {
        label: 'run',
        sleep_ms: 20_000,
        text: 'This run should be cancelled before its final output matters.',
      },
    ]);
    await enableProject(request, CANCELLED_PROJECT, { testsDisabled: true });

    const [successResp, cancelledResp] = await Promise.all([
      request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/run`, {
        data: { prompt: SUCCESS_PROMPT },
      }),
      request.post(`/api/projects/by-project/${CANCELLED_PROJECT}/run`, {
        data: { prompt: CANCELLED_PROMPT },
      }),
    ]);

    expect(successResp.status(), `success run POST failed: ${await successResp.text()}`).toBe(200);
    expect(
      cancelledResp.status(),
      `cancelled run POST failed: ${await cancelledResp.text()}`,
    ).toBe(200);

    const successBody = await successResp.json() as { job_id: string };
    const cancelledBody = await cancelledResp.json() as { job_id: string };
    expect(successBody.job_id, 'success job_id in response').toBeTruthy();
    expect(cancelledBody.job_id, 'cancelled job_id in response').toBeTruthy();

    const [runningSuccess, runningCancelled] = await Promise.all([
      waitForJobByIdRunning(request, successBody.job_id, 20_000),
      waitForJobByIdRunning(request, cancelledBody.job_id, 20_000),
    ]);
    expect(runningSuccess, 'success run should be live').not.toBeNull();
    expect(runningCancelled, 'cancelled run should be live before abort').not.toBeNull();

    await page.goto(`/project/${SUCCESS_PROJECT}/history`);
    const cancelledHistoryPage = await page.context().newPage();
    await cancelledHistoryPage.goto(`/project/${CANCELLED_PROJECT}/history`);
    const successTerminalPage = await page.context().newPage();
    await successTerminalPage.goto(
      `/project/${SUCCESS_PROJECT}/terminal?job=${encodeURIComponent(successBody.job_id)}`,
    );
    const cancelledTerminalPage = await page.context().newPage();
    await cancelledTerminalPage.goto(
      `/project/${CANCELLED_PROJECT}/terminal?job=${encodeURIComponent(cancelledBody.job_id)}`,
    );

    const successRow = runRow(page, SUCCESS_PROMPT);
    const cancelledRow = runRow(cancelledHistoryPage, CANCELLED_PROMPT);

    await expect(successRow).toBeVisible({ timeout: 20_000 });
    await expect(cancelledRow).toBeVisible({ timeout: 20_000 });
    await expect(successRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(cancelledRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(successTerminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(cancelledTerminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });

    const cancelResp = await request.delete(`/api/jobs/${encodeURIComponent(cancelledBody.job_id)}`);
    expect(cancelResp.status(), `cancel DELETE failed: ${await cancelResp.text()}`).toBe(200);

    const cancelledJob = await waitForJobCompletion(request, cancelledBody.job_id, 20_000);
    expect(cancelledJob?.['exit_code'], 'cancelled run exit code').toBe(-2);

    await expect(cancelledRow.getByText('cancelled', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(cancelledRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(cancelledTerminalPage.getByText('live run')).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(cancelledTerminalPage.getByText('cancelled').first()).toBeVisible({
      timeout: 15_000,
    });

    await expect(successRow.getByLabel('running')).toBeVisible();
    await expect(successTerminalPage.getByText('live run')).toBeVisible();

    const successJob = await waitForJobCompletion(request, successBody.job_id, 30_000);
    expect(successJob?.['exit_code'], 'success run exit code').toBe(0);

    await expect(successRow.getByLabel('done')).toBeVisible({ timeout: 15_000 });
    await expect(successRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(successTerminalPage.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(successTerminalPage.getByText('exit 0 — ok').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
