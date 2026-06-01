import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  enableProject,
  waitForPipelineCompletion,
} from './helpers';

// Tests-enabled variant of the review→fix loop. Verifies the core of the
// "tests feed review" behavior end-to-end: when review returns NEEDS ATTENTION
// and a fix is applied, the pipeline re-runs the HOST-side test phase before
// re-reviewing (review → fix → test → review). The re-test must appear between
// the fix and the second review, proving tests actually run inside the review
// loop (not just on the initial pass) and gate the path back to review.
const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-needs-attention.json'), 'utf-8'),
);

const PROJECT = 'review-retest-live';

test.describe('Review-driven fix re-runs host tests before re-review', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    // Tests ENABLED with a fast passing command so the host test phase runs
    // for real on the initial test and again after the review-driven fix.
    await enableProject(request, PROJECT, { testsDisabled: false });
    const configResp = await request.patch(
      `/api/projects/by-project/${PROJECT}/config`,
      { data: { test_command: `bash -lc 'echo tests-pass; exit 0'`, tests_disabled: false } },
    );
    expect(configResp.status(), `config PATCH failed: ${await configResp.text()}`).toBe(200);
  });

  test('review → fix → test → review: re-test runs between fix and the LGTM review', async ({ request }) => {
    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(releaseResp.status(), `release POST failed: ${await releaseResp.text()}`).toBe(200);

    // review → fix → test → review → commit → push: allow extra time for the
    // added host-test hop in the loop.
    const result = await waitForPipelineCompletion(request, PROJECT, 150_000);
    expect(result.status, 'pipeline timed out').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    const jobsResp = await request.get(`/api/jobs?project=${PROJECT}`);
    expect(jobsResp.ok()).toBe(true);
    const { jobs } = await jobsResp.json() as {
      jobs: Array<{ kind: string; exit_code: number | null; started_at: number }>
    };
    const ordered = [...jobs].sort((a, b) => a.started_at - b.started_at);
    // Surface the actual phase order as evidence the host test ran in the loop.
    console.log('[review-retest] phase order:', ordered.map(j => j.kind).join(' → '));

    const reviewJobs = ordered.filter(j => j.kind === 'review');
    const fixJobs = ordered.filter(j => j.kind === 'fix');
    const testJobs = ordered.filter(j => j.kind === 'test');

    expect(reviewJobs.length, 'two review jobs ran').toBe(2);
    expect(fixJobs.length, 'one fix job ran').toBe(1);

    const fixJob = fixJobs[0];
    const secondReview = reviewJobs[1];

    // The key invariant: a host test ran AFTER the review-driven fix and BEFORE
    // the second review — i.e. review → fix → test → review. This is the proof
    // that the host test executes inside the review loop and gates re-review.
    const reTest = testJobs.find(t => t.started_at >= fixJob.started_at && t.started_at <= secondReview.started_at);
    expect(reTest, 'a host test ran between the fix and the second review').toBeDefined();
    expect(reTest!.exit_code, 're-test passed on the host').toBe(0);

    // The second (LGTM) review only runs after that re-test.
    expect(secondReview.started_at).toBeGreaterThanOrEqual(reTest!.started_at);
  });
});
