import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  readShimCalls,
  enableProject,
  waitForJobRunning,
  waitForJobCompletion,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'abort.json'), 'utf-8'),
);

const PROJECT = 'abort';

test.describe('Pipeline abort', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });
  });

  test('aborting a running pipeline marks release as aborted and skips commit/push', async ({ request }) => {
    // Start the pipeline — review will sleep for 15 s, giving us time to abort.
    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    const releaseBody = await releaseResp.json() as { release_job_id: string };
    const releaseJobId = releaseBody.release_job_id;
    expect(releaseJobId, 'release_job_id in response').toBeTruthy();

    // Wait until the review job is actively running before aborting.
    const reviewJob = await waitForJobRunning(request, PROJECT, 'review', 20_000);
    expect(reviewJob, 'review job should be running before abort').not.toBeNull();

    // Abort the pipeline.
    const abortResp = await request.post(`/api/projects/by-project/${PROJECT}/release/abort`);
    expect(abortResp.status()).toBe(200);
    const abortBody = await abortResp.json() as { status: string; release_id: string; killed_job_id: string | null };
    expect(abortBody.status).toBe('aborted');
    expect(abortBody.killed_job_id, 'a running step was killed').toBeTruthy();

    // Wait for the release job's finished_at to be written (the abort route
    // sets it synchronously, so this should resolve immediately).
    const finished = await waitForJobCompletion(request, releaseJobId, 10_000);
    expect(finished, 'release job should have finished_at after abort').not.toBeNull();

    // Verify the release job exit code is -3 (aborted).
    expect(finished!['exit_code'], 'release exit_code is -3').toBe(-3);

    // Verify no jobs ran after the abort — commit and push must not appear.
    const jobsResp = await request.get(`/api/jobs?project=${PROJECT}`);
    expect(jobsResp.ok()).toBe(true);
    const { jobs } = await jobsResp.json() as { jobs: Array<{ kind: string }> };
    const kinds = jobs.map(j => j.kind);
    expect(kinds, 'commit should not run after abort').not.toContain('commit');
    expect(kinds, 'push should not run after abort').not.toContain('push');

    // Git shim should not have recorded any commit or push calls.
    const calls = readShimCalls(PROJECT);
    const commitCalls = calls.filter(c => c.args.includes('commit'));
    const pushCalls = calls.filter(c => c.args.includes('push'));
    expect(commitCalls.length, 'no git commit after abort').toBe(0);
    expect(pushCalls.length, 'no git push after abort').toBe(0);
  });
});
