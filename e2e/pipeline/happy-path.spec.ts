import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  readShimCalls,
  enableProject,
  waitForPipelineCompletion,
  assertGitCallOnce,
} from './helpers';

// Scenario JSON lives next to the scenarios directory for easy authoring.
const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'happy-path.json'), 'utf-8'),
);

const PROJECT = 'happy-path';

test.describe('Happy-path pipeline', () => {
  test.beforeAll(async ({ request }) => {
    // Write the scenario steps and reset git + counter state.
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);

    // Enable the project with tests disabled so the pipeline goes
    // straight to review → commit → push.
    await enableProject(request, PROJECT, { testsDisabled: true });
  });

  test('release → review (LGTM) → commit → push: all steps complete and git calls recorded', async ({ request }) => {
    // Trigger the release pipeline.
    const releaseResp = await request.post(
      `/api/projects/by-project/${PROJECT}/release`,
    );
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    // Wait for the release job to finish (up to 90 s).
    const result = await waitForPipelineCompletion(request, PROJECT, 90_000);
    expect(result.status, 'pipeline timed out').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    // Verify that git shim recorded the expected calls.
    const calls = readShimCalls(PROJECT);

    // git add -A must have been called exactly once.
    assertGitCallOnce(calls, 'add', 'add -A');

    // git commit -m <msg> must have been called exactly once.
    const commitCalls = calls.filter(c => c.args.includes('commit'));
    expect(commitCalls.length, 'git commit call count').toBe(1);
    const commitMsgArg = commitCalls[0].args.find(a => a.startsWith('feat:'));
    expect(commitMsgArg, 'commit message starts with feat:').toBeTruthy();

    // git push must have been called exactly once.
    assertGitCallOnce(calls, 'push', 'push');

    // Verify jobs in DB reflect the pipeline steps.
    const jobsResp = await request.get(`/api/jobs?project=${PROJECT}`);
    expect(jobsResp.ok()).toBe(true);
    const { jobs } = await jobsResp.json() as { jobs: Array<{ kind: string; exit_code: number | null }> };

    const kinds = jobs.map(j => j.kind);
    expect(kinds).toContain('review');
    expect(kinds).toContain('commit');
    expect(kinds).toContain('push');

    const reviewJob = jobs.find(j => j.kind === 'review');
    expect(reviewJob?.exit_code, 'review exit_code').toBe(0);

    const pushJob = jobs.find(j => j.kind === 'push');
    expect(pushJob?.exit_code, 'push exit_code').toBe(0);
  });
});
