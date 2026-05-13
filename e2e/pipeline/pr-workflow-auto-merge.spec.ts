import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  readShimCalls,
  enableProject,
  waitForPipelineCompletion,
  writeGitBranch,
  writeGhPrStatuses,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'pr-workflow-auto-merge.json'), 'utf-8'),
);

const PROJECT = 'pr-workflow-auto-merge';

test.describe('PR Workflow auto-merge pipeline', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    writeGitBranch(PROJECT, 'feature/pr-workflow-auto-merge');
    writeGhPrStatuses(PROJECT, [
      {
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ name: 'CI', status: 'IN_PROGRESS', conclusion: null }],
      },
      {
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
    ]);
    await enableProject(request, PROJECT, {
      testsDisabled: true,
      autoPushEnabled: true,
      autoPrMergeEnabled: true,
    });
  });

  test('waits for green PR checks, merges, runs DoD, and returns to default branch', async ({ request }) => {
    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(releaseResp.status(), `release POST failed: ${await releaseResp.text()}`).toBe(200);

    const result = await waitForPipelineCompletion(request, PROJECT, 120_000);
    expect(result.status, 'pipeline timed out').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    const jobsResp = await request.get(`/api/jobs?project=${PROJECT}`);
    expect(jobsResp.ok()).toBe(true);
    const { jobs } = await jobsResp.json() as {
      jobs: Array<{ kind: string; exit_code: number | null; started_at: number }>;
    };

    const orderedKinds = [...jobs]
      .sort((a, b) => a.started_at - b.started_at)
      .map(j => j.kind);
    expect(orderedKinds).toEqual(expect.arrayContaining(['review', 'commit', 'push', 'pr-wait', 'mark-dod']));

    const prWaitJob = jobs.find(j => j.kind === 'pr-wait');
    expect(prWaitJob?.exit_code, 'pr-wait exit code').toBe(0);
    const markDodJob = jobs.find(j => j.kind === 'mark-dod');
    expect(markDodJob?.exit_code, 'mark-dod exit code').toBe(0);

    const calls = readShimCalls(PROJECT);
    const pushIndex = calls.findIndex(c => !c.cmd && c.args.includes('push'));
    const prCreateIndex = calls.findIndex(c => c.cmd === 'gh' && c.args.includes('pr') && c.args.includes('create'));
    const pendingCheckIndex = calls.findIndex(c => c.cmd === 'gh' && c.result === 'checks:IN_PROGRESS');
    const passingCheckIndex = calls.findIndex(c => c.cmd === 'gh' && c.result === 'checks:COMPLETED');
    const mergeIndex = calls.findIndex(c => c.cmd === 'gh' && c.args.includes('pr') && c.args.includes('merge'));
    const checkoutDefaultIndex = calls.findIndex(c => !c.cmd && c.args.includes('checkout') && c.args.includes('master'));

    expect(pushIndex, 'git push happened').toBeGreaterThanOrEqual(0);
    expect(prCreateIndex, 'gh pr create happened after push').toBeGreaterThan(pushIndex);
    expect(pendingCheckIndex, 'first PR status poll was pending').toBeGreaterThan(prCreateIndex);
    expect(passingCheckIndex, 'second PR status poll was passing').toBeGreaterThan(pendingCheckIndex);
    expect(mergeIndex, 'gh pr merge happened after passing checks').toBeGreaterThan(passingCheckIndex);
    expect(checkoutDefaultIndex, 'working copy returned to default branch after merge').toBeGreaterThan(mergeIndex);
  });
});
