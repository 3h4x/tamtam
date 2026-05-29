import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  readShimCalls,
  enableProject,
  waitForPipelineCompletion,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'review-cap-exhaustion.json'), 'utf-8'),
);

const PROJECT = 'review-cap-exhaustion';

test.describe('Review-cap exhaustion → file issue + ship anyway', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });

    // Pin the review/fix loop cap to 1 so the second review trips the cap
    // immediately and the exhaustion fallback fires after a single fix
    // iteration. Cuts the test runtime to one review→fix→review cycle.
    const patch = await request.patch('/api/settings', {
      data: { fix_max_iterations: '1' },
    });
    expect(patch.ok(), `failed to set fix_max_iterations: ${patch.status()}`).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    // Restore the default so other specs in the same harness aren't affected.
    await request.patch('/api/settings', { data: { fix_max_iterations: '3' } });
  });

  test('files a follow-up issue and chains to commit + push when review cap trips', async ({ request }) => {
    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(releaseResp.status(), `release POST failed: ${await releaseResp.text()}`).toBe(200);

    const result = await waitForPipelineCompletion(request, PROJECT, 120_000);
    expect(result.status, 'pipeline timed out').toBe('done');

    // Sanity: jobs ran in the expected order.
    const jobsResp = await request.get(`/api/jobs?project=${PROJECT}`);
    expect(jobsResp.ok()).toBe(true);
    const { jobs } = (await jobsResp.json()) as {
      jobs: Array<{ kind: string; exit_code: number | null; started_at: number; verdict?: string }>;
    };
    const ordered = [...jobs].sort((a, b) => a.started_at - b.started_at);
    const reviewJobs = ordered.filter((j) => j.kind === 'review');
    const fixJobs = ordered.filter((j) => j.kind === 'fix');
    const commitJobs = ordered.filter((j) => j.kind === 'commit');
    const pushJobs = ordered.filter((j) => j.kind === 'push');

    // With cap=1: review#1 NEEDS ATTENTION → fix → fix→review hook trips the
    // cap (reviewCount=1 ≥ max=1) and the exhaustion fallback fires before
    // review#2 starts. So we expect exactly 1 review + 1 fix.
    expect(reviewJobs.length, 'one review ran before the cap tripped').toBe(1);
    expect(fixJobs.length, 'one fix ran from the NEEDS ATTENTION verdict').toBe(1);
    expect(reviewJobs[0].verdict).toBe('NEEDS ATTENTION');
    expect(commitJobs.length, 'commit fired via the exhaustion fallback (no LGTM reached)').toBeGreaterThanOrEqual(1);
    expect(pushJobs.length, 'push fired after commit').toBeGreaterThanOrEqual(1);
    // commit must come AFTER the fix that tripped the cap — proves the
    // fallback chained, not a regression to a fresh LGTM path.
    expect(commitJobs[0].started_at).toBeGreaterThan(fixJobs[0].started_at);

    // The exhaustion fallback hit the gh shim with `gh issue create`.
    const calls = readShimCalls(PROJECT);
    const issueCreateCall = calls.find(
      (c) => c.cmd === 'gh' && c.args.includes('issue') && c.args.includes('create'),
    );
    expect(issueCreateCall, 'gh issue create was invoked by the exhaustion fallback').toBeDefined();

    // Sanity: title + labels match the canonical TamTam contract.
    const args = issueCreateCall!.args;
    const titleIdx = args.indexOf('--title');
    // Title carries no invocation metadata — either the headline Finding ID (with optional "+N more") or the bare form.
    expect(args[titleIdx + 1]).toMatch(/^chore\(review\): ([a-z0-9][a-z0-9 ]*( \(\+\d+ more\))?|unresolved review)$/);
    const labels = args.reduce<string[]>(
      (acc, v, i) => (args[i - 1] === '--label' ? [...acc, v] : acc),
      [],
    );
    expect(labels).toEqual(expect.arrayContaining(['tamtam', 'review-followup', 'priority-medium']));

    // Body should reference the unresolved Finding ID surfaced in every review,
    // expose the structured fields the reviewer emitted (severity, root cause,
    // required fix), and contain none of the stream-json telemetry that the
    // raw log carries — that's the user-facing tightening.
    const bodyIdx = args.indexOf('--body');
    const body = args[bodyIdx + 1];
    expect(body).toContain('persistent-null-check');
    expect(body).toContain('severity: medium');
    expect(body).toContain('handler still missing null guard');
    expect(body).toContain('add a guard');
    expect(body).not.toContain('stream_event');
    expect(body).not.toContain('content_block_delta');
    expect(body).not.toContain('[tamtam] launching');
    // No invocation metadata leaks: no release handle, no review job id, no
    // dangerous permission flags.
    expect(body).not.toMatch(/Release `/);
    expect(body).not.toContain('review job');
    expect(body).not.toContain('--permission-mode');
    expect(body).not.toContain('bypassPermissions');

    // git push must have been invoked — the partial work shipped.
    const pushCall = calls.find((c) => !c.cmd && c.args.includes('push'));
    expect(pushCall, 'git push ran after the exhaustion fallback chained to push').toBeDefined();
  });
});
