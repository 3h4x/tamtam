import { test, expect } from '@playwright/test';
import {
  writeScenario,
  resetShimState,
  enableProject,
  waitForPipelineCompletion,
} from './helpers';

const PROJECT = 'paused';

test.describe('Jobs-paused global gate', () => {
  test.beforeAll(async ({ request }) => {
    // Register the project so it exists in the DB before any test runs.
    // The paused-gate check in startRelease happens after the project lookup,
    // so the project must be present even for the "should return 409" test.
    await enableProject(request, PROJECT, { testsDisabled: true });
  });

  test.afterEach(async ({ request }) => {
    // Always restore jobs_paused=false so subsequent specs aren't blocked.
    await request.patch('/api/settings', { data: { jobs_paused: false } });
  });

  test('release returns 409 when jobs are paused', async ({ request }) => {
    await request.patch('/api/settings', { data: { jobs_paused: true } });

    const resp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(resp.status(), 'should be blocked with 409').toBe(409);

    const body = await resp.json() as { detail: string };
    expect(body.detail).toMatch(/paused/i);
  });

  test('release succeeds immediately after unpausing', async ({ request }) => {
    writeScenario(PROJECT, [
      { label: 'review', text: 'Clean implementation.\n\nVerdict: LGTM' },
      { label: 'commit-message', text: 'feat: paused test pipeline' },
    ]);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });

    // Pause then confirm blocked.
    await request.patch('/api/settings', { data: { jobs_paused: true } });
    const blocked = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(blocked.status()).toBe(409);

    // Unpause.
    await request.patch('/api/settings', { data: { jobs_paused: false } });

    // Trigger and verify the pipeline runs to completion.
    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed after unpause: ${await releaseResp.text()}`,
    ).toBe(200);

    const result = await waitForPipelineCompletion(request, PROJECT, 90_000);
    expect(result.status, 'release job should complete after unpause').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release should succeed (exit 0)').toBe(0);
  });
});
