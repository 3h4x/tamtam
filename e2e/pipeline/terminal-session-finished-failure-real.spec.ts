import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import {
  enableProject,
  resetShimState,
  waitForJobCompletion,
  writeScenario,
} from './helpers';

const PROJECT = 'terminal-run-session-finished-failure';
const PROMPT = 'Finish this ordinary run with a provider failure so restore can show the error.';

async function waitForJobSessionId(request: APIRequestContext, jobId: string): Promise<string> {
  await expect.poll(async () => {
    const jobResp = await request.get(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!jobResp.ok()) return null;
    const jobDetail = await jobResp.json() as { session_id: string | null };
    return jobDetail.session_id;
  }, {
    message: 'failed run should keep a session_id for restore',
    timeout: 15_000,
  }).toBeTruthy();

  const jobResp = await request.get(`/api/jobs/${encodeURIComponent(jobId)}`);
  const jobDetail = await jobResp.json() as { session_id: string | null };
  return jobDetail.session_id as string;
}

test.describe('Real failed ordinary run session restore', () => {
  test('failed run reopens on the canonical terminal session route after it settles', async ({
    page,
    request,
  }) => {
    resetShimState(PROJECT);
    writeScenario(PROJECT, [
      {
        label: 'run',
        sleep_ms: 2000,
        text: 'Finished ordinary run failure output is available on the restored session route.',
        prompt_assert_contains: ['this required text is intentionally absent'],
      },
    ]);
    await enableProject(request, PROJECT, { testsDisabled: true });

    const runResp = await request.post(`/api/projects/by-project/${PROJECT}/run`, {
      data: { prompt: PROMPT },
    });
    expect(runResp.status(), `run POST failed: ${await runResp.text()}`).toBe(200);

    const runBody = await runResp.json() as { job_id: string };
    expect(runBody.job_id, 'run job_id in response').toBeTruthy();

    const runJob = await waitForJobCompletion(request, runBody.job_id, 60_000);
    expect(runJob?.['exit_code'], 'run exit code').toBe(1);

    const sessionId = await waitForJobSessionId(request, runBody.job_id);

    await page.goto(`/project/${PROJECT}/terminal/${encodeURIComponent(sessionId)}`);

    await expect(page.getByText(PROMPT)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('claude run failed').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('PROMPT ASSERTION FAILED').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText('Finished ordinary run failure output is available on the restored session route.').first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 20_000 });
    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal/e2e-session-${PROJECT}-\\d+$`),
    );
  });
});
