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
  writeGhOpenPr,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'pr-workflow-auto-merge.json'), 'utf-8'),
);

const PROJECT = 'pr-workflow-reuse-existing-pr';
const FEATURE_BRANCH = 'feature/reuse-existing-pr';
const PR_URL = 'https://github.com/test/repo/pull/7';

test.describe('PR Workflow existing PR reuse', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    writeGitBranch(PROJECT, FEATURE_BRANCH);
    writeGhOpenPr(PROJECT, {
      number: 7,
      url: PR_URL,
      headBranch: FEATURE_BRANCH,
      title: 'Existing PR',
      body: '',
      state: 'OPEN',
      author: { login: 'trusted-user' },
    });
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

  test('reuses the open PR instead of creating a new one before auto-merge', async ({ request }) => {
    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(releaseResp.status(), `release POST failed: ${await releaseResp.text()}`).toBe(200);

    const result = await waitForPipelineCompletion(request, PROJECT, 120_000);
    expect(result.status, 'pipeline timed out').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    const calls = readShimCalls(PROJECT);
    const pushIndex = calls.findIndex(c => !c.cmd && c.args.includes('push'));
    const reuseViewIndex = calls.findIndex(
      c => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view' && c.args.includes('url'),
    );
    const prCreateIndex = calls.findIndex(c => c.cmd === 'gh' && c.args.includes('pr') && c.args.includes('create'));
    const pendingCheckIndex = calls.findIndex(c => c.cmd === 'gh' && c.result === 'checks:IN_PROGRESS');
    const passingCheckIndex = calls.findIndex(c => c.cmd === 'gh' && c.result === 'checks:COMPLETED');
    const mergeIndex = calls.findIndex(c => c.cmd === 'gh' && c.args.includes('pr') && c.args.includes('merge'));

    expect(pushIndex, 'git push happened').toBeGreaterThanOrEqual(0);
    expect(reuseViewIndex, 'gh pr view looked up the existing PR on the feature branch').toBeGreaterThan(pushIndex);
    expect(prCreateIndex, 'gh pr create was not called when a PR already existed').toBe(-1);
    expect(pendingCheckIndex, 'first PR status poll was pending').toBeGreaterThan(reuseViewIndex);
    expect(passingCheckIndex, 'second PR status poll was passing').toBeGreaterThan(pendingCheckIndex);
    expect(mergeIndex, 'gh pr merge happened after passing checks').toBeGreaterThan(passingCheckIndex);
  });
});
