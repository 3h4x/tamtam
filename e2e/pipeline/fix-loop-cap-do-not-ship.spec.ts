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
  readFileSync(join(__dirname, 'scenarios', 'fix-loop-cap-do-not-ship.json'), 'utf-8'),
);

const PROJECT = 'fix-loop-cap-do-not-ship';

test.describe('Fix-loop cap for DO NOT SHIP reviews', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });

    const patch = await request.patch('/api/settings', {
      data: { fix_max_iterations: '3' },
    });
    expect(patch.ok(), `failed to set fix_max_iterations: ${patch.status()}`).toBe(true);
  });

  test('stops after three fixes and does not commit or push', async ({ request }) => {
    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(releaseResp.status(), `release POST failed: ${await releaseResp.text()}`).toBe(200);

    const result = await waitForPipelineCompletion(request, PROJECT, 180_000);
    expect(result.status, 'pipeline timed out').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').not.toBe(0);

    const jobsResp = await request.get(`/api/jobs?project=${PROJECT}`);
    expect(jobsResp.ok()).toBe(true);
    const { jobs } = await jobsResp.json() as {
      jobs: Array<{
        id: string;
        kind: string;
        exit_code: number | null;
        started_at: number;
        verdict?: string;
      }>;
    };

    const ordered = [...jobs].sort((a, b) => a.started_at - b.started_at);
    const reviewJobs = ordered.filter(j => j.kind === 'review');
    const fixJobs = ordered.filter(j => j.kind === 'fix');
    const forbiddenKinds = new Set(['commit', 'push', 'mark-dod', 'pr-wait', 'merge']);

    expect(reviewJobs.length, 'three reviews ran before the cap blocked review #4').toBe(3);
    expect(reviewJobs.map(j => j.verdict), 'all completed reviews were blocking').toEqual([
      'DO NOT SHIP',
      'DO NOT SHIP',
      'DO NOT SHIP',
    ]);
    expect(fixJobs.length, 'three fixes landed before verification budget was exhausted').toBe(3);
    expect(ordered.filter(j => forbiddenKinds.has(j.kind)), 'no downstream side-effect steps ran').toEqual([]);

    const calls = readShimCalls(PROJECT);
    expect(calls.some(c => !c.cmd && c.args.includes('commit')), 'git commit was not invoked').toBe(false);
    expect(calls.some(c => !c.cmd && c.args.includes('push')), 'git push was not invoked').toBe(false);
    expect(
      calls.some(c => c.cmd === 'gh' && c.args.includes('issue') && c.args.includes('create')),
      'DO NOT SHIP exhaustion does not file a follow-up issue',
    ).toBe(false);

    const releaseId = result.releaseJob?.['id'];
    expect(typeof releaseId, 'release job id').toBe('string');
    const releaseDetailResp = await request.get(`/api/jobs/${encodeURIComponent(releaseId as string)}`);
    expect(releaseDetailResp.ok()).toBe(true);
    const releaseDetail = await releaseDetailResp.json() as { log?: string };
    expect(releaseDetail.log ?? '').toContain('review cap reached');
  });
});
