import { test, expect } from '@playwright/test';
import {
  enableProject,
  resetShimState,
  waitForJobCompletion,
  writeScenario,
} from './helpers';

const PROJECT = 'terminal-run-session-finished';
const PROMPT = 'Finish this ordinary run so the canonical session route can restore it.';

test.describe('Real finished ordinary run session restore', () => {
  test('completed run can reopen on the canonical terminal session route after it settles', async ({
    page,
    request,
  }) => {
    resetShimState(PROJECT);
    writeScenario(PROJECT, [
      {
        label: 'run',
        sleep_ms: 2000,
        text: 'Finished ordinary run output is available on the restored session route.',
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
    expect(runJob?.['exit_code'], 'run exit code').toBe(0);

    const jobResp = await request.get(`/api/jobs/${encodeURIComponent(runBody.job_id)}`);
    expect(jobResp.status(), `job GET failed: ${await jobResp.text()}`).toBe(200);
    const jobDetail = await jobResp.json() as {
      session_id: string | null;
      prompt: string | null;
      user_prompt: string | null;
    };
    expect(jobDetail.session_id, 'finished run should keep a session_id for restore').toBeTruthy();

    await page.goto(
      `/project/${PROJECT}/terminal/${encodeURIComponent(jobDetail.session_id as string)}`,
    );

    await expect(page.getByText(PROMPT)).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText('Finished ordinary run output is available on the restored session route.'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('exit 0 — ok')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText('live run')).toHaveCount(0, { timeout: 20_000 });
    await expect(page).toHaveURL(
      new RegExp(`/project/${PROJECT}/terminal/${encodeURIComponent(jobDetail.session_id as string)}$`),
    );
  });
});
