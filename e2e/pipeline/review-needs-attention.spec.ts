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

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-needs-attention.json'), 'utf-8'),
);

const PROJECT = 'needs-attention';

test.describe('Review needs-attention pipeline', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });
  });

  test('fix fires after NEEDS ATTENTION; commit only runs after subsequent LGTM', async ({ request }) => {
    // Trigger the release pipeline.
    const releaseResp = await request.post(
      `/api/projects/by-project/${PROJECT}/release`,
    );
    expect(
      releaseResp.status(),
      `release POST failed: ${await releaseResp.text()}`,
    ).toBe(200);

    // Wait for the release to finish (longer timeout: review → fix → review chain).
    const result = await waitForPipelineCompletion(request, PROJECT, 120_000);
    expect(result.status, 'pipeline timed out').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    // Inspect the jobs sequence.
    const jobsResp = await request.get(`/api/jobs?project=${PROJECT}`);
    expect(jobsResp.ok()).toBe(true);
    const { jobs } = await jobsResp.json() as {
      jobs: Array<{ kind: string; exit_code: number | null; started_at: number; verdict?: string }>
    };

    // Sort jobs by start time to verify ordering.
    const ordered = [...jobs].sort((a, b) => a.started_at - b.started_at);
    const kinds = ordered.map(j => j.kind);

    // The chain must include: review, fix, review (second), commit, push.
    const reviewJobs = ordered.filter(j => j.kind === 'review');
    const fixJobs = ordered.filter(j => j.kind === 'fix');

    expect(reviewJobs.length, 'two review jobs ran').toBe(2);
    expect(fixJobs.length, 'one fix job ran').toBe(1);

    // Fix must have started AFTER the first review.
    const firstReview = reviewJobs[0];
    const fixJob = fixJobs[0];
    expect(fixJob.started_at).toBeGreaterThanOrEqual(firstReview.started_at);

    // Commit must not appear before the second (LGTM) review finished.
    const commitJob = ordered.find(j => j.kind === 'commit');
    expect(commitJob, 'commit job exists').toBeDefined();
    const secondReview = reviewJobs[1];
    expect(commitJob!.started_at).toBeGreaterThanOrEqual(secondReview.started_at);

    // Verify git calls: commit and push each once.
    const calls = readShimCalls(PROJECT);
    expect(calls.some(c => c.args.includes('add') && c.args.includes('-u')), 'git add -u call').toBe(true);
    assertGitCallOnce(calls, 'commit', 'commit');
    assertGitCallOnce(calls, 'push', 'push');

    // Verdicts on review jobs
    expect(kinds).toContain('fix');
    expect(kinds.indexOf('fix')).toBeLessThan(kinds.lastIndexOf('review'));
  });
});
