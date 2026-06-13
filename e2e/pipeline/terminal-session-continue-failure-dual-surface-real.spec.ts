import { test, expect } from '@playwright/test';
import {
  enableProject,
  resetShimState,
  waitForJobByIdRunning,
  waitForJobCompletion,
  writeScenario,
} from './helpers';

const PROJECT = 'terminal-run-session-continue-dual-surface-failure';
const INITIAL_PROMPT =
  'Finish the first ordinary run so the canonical session route can be resumed before failing.';

async function runningJobCount(request: import('@playwright/test').APIRequestContext): Promise<number> {
  const resp = await request.get(`/api/jobs?project=${encodeURIComponent(PROJECT)}`);
  if (!resp.ok()) return -1;
  const body = await resp.json() as { jobs?: Array<{ status?: string; finished_at?: string | null }> };
  return (body.jobs ?? []).filter((job) => job.status === 'running' || job.finished_at == null).length;
}

test.describe('Real resumed ordinary run failure across history and terminal session route', () => {
  test('history and the canonical terminal session route show continued-run failures and clear live state after capped recovery attempts settle', async ({
    page,
    request,
  }) => {
    resetShimState(PROJECT);
    writeScenario(PROJECT, [
      {
        label: 'run',
        sleep_ms: 2000,
        text: 'Initial session output is available before the failing continuation starts.',
      },
    ]);
    await enableProject(request, PROJECT, { testsDisabled: true });

    const initialRunResp = await request.post(`/api/projects/by-project/${PROJECT}/run`, {
      data: { prompt: INITIAL_PROMPT },
    });
    expect(initialRunResp.status(), `initial run POST failed: ${await initialRunResp.text()}`).toBe(200);

    const initialRunBody = await initialRunResp.json() as { job_id: string };
    expect(initialRunBody.job_id, 'initial run job_id in response').toBeTruthy();

    const initialRunJob = await waitForJobCompletion(request, initialRunBody.job_id, 60_000);
    expect(initialRunJob?.['exit_code'], 'initial run exit code').toBe(0);

    const initialJobResp = await request.get(`/api/jobs/${encodeURIComponent(initialRunBody.job_id)}`);
    expect(initialJobResp.status(), `initial job GET failed: ${await initialJobResp.text()}`).toBe(200);
    const initialJobDetail = await initialJobResp.json() as { session_id: string | null };
    expect(initialJobDetail.session_id, 'finished run should keep a session_id for continue').toBeTruthy();

    writeScenario(PROJECT, [
      {
        label: 'run',
        sleep_ms: 10000,
        text: 'The resumed ordinary run failed on the existing session route.',
        prompt_assert_contains: ['this required text is intentionally absent from the continuation prompt'],
      },
    ]);

    const terminalPage = await page.context().newPage();
    await Promise.all([
      page.goto(`/project/${PROJECT}/history`),
      terminalPage.goto(
        `/project/${PROJECT}/terminal/${encodeURIComponent(initialJobDetail.session_id as string)}`,
      ),
    ]);

    await expect(page.getByText(INITIAL_PROMPT)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('1 running')).toHaveCount(0);
    await expect(terminalPage.getByText(INITIAL_PROMPT)).toBeVisible({ timeout: 20_000 });
    await expect(
      terminalPage.getByText('Initial session output is available before the failing continuation starts.'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(terminalPage.getByText('live run')).toHaveCount(0);

    const continueResp = await request.post(
      `/api/jobs/${encodeURIComponent(initialRunBody.job_id)}/continue`,
    );
    expect(continueResp.status(), `continue POST failed: ${await continueResp.text()}`).toBe(200);

    const continueBody = await continueResp.json() as { job_id: string; resumed_session_id: string };
    expect(continueBody.job_id, 'continued run job_id in response').toBeTruthy();
    expect(
      continueBody.resumed_session_id,
      'continued run should target the original session',
    ).toBe(initialJobDetail.session_id);

    const runningContinuation = await waitForJobByIdRunning(request, continueBody.job_id, 20_000);
    expect(runningContinuation, 'continued run should be running').not.toBeNull();

    await expect(page.getByText('1 running')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(1, { timeout: 20_000 });
    await expect(terminalPage.getByText('live run')).toBeVisible({ timeout: 20_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 20_000 });
    await expect(terminalPage).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal/${encodeURIComponent(initialJobDetail.session_id as string)}$`),
    );

    const continuedJob = await waitForJobCompletion(request, continueBody.job_id, 60_000);
    expect(continuedJob?.['exit_code'], 'continued run exit code after failure').toBe(1);

    const failedRow = page.getByRole('button').filter({ hasText: 'exit 1' }).first();
    await expect(failedRow).toBeVisible({ timeout: 15_000 });
    await expect(failedRow.getByText('exit 1', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await expect.poll(() => runningJobCount(request), {
      message: 'auto-resume recovery attempts should eventually settle',
      timeout: 60_000,
    }).toBe(0);

    await expect(page.getByText('1 running')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
    await expect(failedRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(terminalPage.getByText('live run')).toHaveCount(0, { timeout: 15_000 });
    await expect(terminalPage.getByLabel('live run spinner')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(terminalPage.getByText('PROMPT ASSERTION FAILED').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      terminalPage.getByText('The resumed ordinary run failed on the existing session route.').first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(terminalPage).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal/e2e-session-${PROJECT}-\\d+$`),
    );
  });
});
