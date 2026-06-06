import { test, expect } from '@playwright/test';
import {
  enableProject,
  resetShimState,
  waitForJobByIdRunning,
  waitForJobCompletion,
  writeScenario,
} from './helpers';
import { CLAUDE_SHIM } from './global-setup';

const SUCCESS_PROJECT = 'concurrent-runs-real-success';
const FAILURE_PROJECT = 'concurrent-runs-real-failure';

const SUCCESS_PROMPT = 'Keep this ordinary run alive while another project fails.';
const FAILURE_PROMPT = 'Fail this ordinary run while the other project keeps streaming.';

function runRow(page: import('@playwright/test').Page, prompt: string) {
  return page.getByRole('button').filter({ hasText: prompt }).first();
}

test.describe('Real concurrent ordinary runs across projects with failure', () => {
  test.beforeEach(async ({ request }) => {
    const patch = await request.patch('/api/settings', {
      data: {
        claude_bin: CLAUDE_SHIM,
        cli_bin_claude: CLAUDE_SHIM,
      },
    });
    expect(patch.ok(), `failed to pin claude e2e shim: ${patch.status()}`).toBe(true);
  });

  test('one project can fail while another stays live, and both surfaces settle independently', async ({
    page,
    request,
  }) => {
    resetShimState(SUCCESS_PROJECT);
    writeScenario(SUCCESS_PROJECT, [
      {
        label: 'run',
        sleep_ms: 20_000,
        text: 'The surviving run finished successfully after the other project failed.',
      },
    ]);
    await enableProject(request, SUCCESS_PROJECT, { testsDisabled: true });

    resetShimState(FAILURE_PROJECT);
    writeScenario(FAILURE_PROJECT, [
      {
        label: 'run',
        sleep_ms: 4_000,
        text: 'The provider failed before finishing the concurrent run.',
        prompt_assert_contains: ['this text is intentionally absent from the prompt'],
      },
    ]);
    await enableProject(request, FAILURE_PROJECT, { testsDisabled: true });

    const [successResp, failureResp] = await Promise.all([
      request.post(`/api/projects/by-project/${SUCCESS_PROJECT}/run`, {
        data: { prompt: SUCCESS_PROMPT },
      }),
      request.post(`/api/projects/by-project/${FAILURE_PROJECT}/run`, {
        data: { prompt: FAILURE_PROMPT },
      }),
    ]);

    expect(successResp.status(), `success run POST failed: ${await successResp.text()}`).toBe(200);
    expect(failureResp.status(), `failure run POST failed: ${await failureResp.text()}`).toBe(200);

    const successBody = await successResp.json() as { job_id: string };
    const failureBody = await failureResp.json() as { job_id: string };
    expect(successBody.job_id, 'success job_id in response').toBeTruthy();
    expect(failureBody.job_id, 'failure job_id in response').toBeTruthy();

    const [runningSuccess, runningFailure] = await Promise.all([
      waitForJobByIdRunning(request, successBody.job_id, 20_000),
      waitForJobByIdRunning(request, failureBody.job_id, 20_000),
    ]);
    expect(runningSuccess, 'success run should be live').not.toBeNull();
    expect(runningFailure, 'failure run should be live before it fails').not.toBeNull();

    await page.goto(`/project/${SUCCESS_PROJECT}/history`);
    const failureHistoryPage = await page.context().newPage();
    await failureHistoryPage.goto(`/project/${FAILURE_PROJECT}/history`);
    const successTerminalPage = await page.context().newPage();
    await successTerminalPage.goto(
      `/project/${SUCCESS_PROJECT}/terminal?job=${encodeURIComponent(successBody.job_id)}`,
    );
    const failureTerminalPage = await page.context().newPage();
    await failureTerminalPage.goto(
      `/project/${FAILURE_PROJECT}/terminal?job=${encodeURIComponent(failureBody.job_id)}`,
    );

    const successRow = runRow(page, SUCCESS_PROMPT);
    const failureRow = runRow(failureHistoryPage, FAILURE_PROMPT);

    await expect(successRow).toBeVisible({ timeout: 20_000 });
    await expect(failureRow).toBeVisible({ timeout: 20_000 });
    await expect(successRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(failureRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(successTerminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(failureTerminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });

    const failureJob = await waitForJobCompletion(request, failureBody.job_id, 20_000);
    expect(failureJob?.['exit_code'], 'failed run exit code').toBe(1);

    await expect(failureRow.getByText('exit 1').first()).toBeVisible({ timeout: 15_000 });
    await expect(failureRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(
      failureHistoryPage.getByRole('button', { name: /failed 1/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(failureTerminalPage.getByText('live run')).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(failureTerminalPage.getByText('PROMPT ASSERTION FAILED').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      failureTerminalPage.getByText('The provider failed before finishing the concurrent run.'),
    ).toBeVisible({ timeout: 15_000 });

    await expect(successRow.getByLabel('running')).toBeVisible();
    await expect(successTerminalPage.getByText('live run')).toBeVisible();

    const successJob = await waitForJobCompletion(request, successBody.job_id, 30_000);
    expect(successJob?.['exit_code'], 'success run exit code').toBe(0);

    await expect(successRow.getByLabel('done')).toBeVisible({ timeout: 15_000 });
    await expect(successRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(successTerminalPage.getByText('live run')).not.toBeVisible({ timeout: 15_000 });
    await expect(successTerminalPage.getByText(SUCCESS_PROMPT)).toBeVisible({ timeout: 15_000 });
  });
});
