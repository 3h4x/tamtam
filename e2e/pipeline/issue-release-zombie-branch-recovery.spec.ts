import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  writeScenario,
  resetShimState,
  readGitBranch,
  readShimCalls,
  enableProject,
  waitForJobCompletion,
  waitForPipelineCompletion,
  writeGitFailures,
  writeGitMergedBranches,
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'issue-release-auto-branch.json'), 'utf-8'),
);

const PROJECT = 'issue-release-zombie-branch-recovery';
const ISSUE_NUMBER = 42;
const ISSUE_TITLE = 'Test issue';
const EXPECTED_BRANCH = 'fix/issue-42-test-issue';

test.describe('Issue-linked release zombie branch recovery', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    writeGitMergedBranches(PROJECT, [EXPECTED_BRANCH]);
    writeGitFailures(PROJECT, {
      checkout: {
        exitCode: 128,
        stderr: 'branch already exists',
        matchArgs: ['-b', EXPECTED_BRANCH],
        once: true,
      },
    });
    await enableProject(request, PROJECT, {
      testsDisabled: true,
      autoPushEnabled: true,
    });
  });

  test('deletes the merged zombie branch and recreates it before commit', async ({ request }) => {
    const runResp = await request.post(`/api/projects/by-project/${PROJECT}/run`, {
      data: {
        prompt: 'Prepare the issue-linked release context.',
        ghIssueNumber: ISSUE_NUMBER,
        ghIssueRepo: 'owner/repo',
        ghIssueTitle: ISSUE_TITLE,
      },
    });
    expect(runResp.status(), `run POST failed: ${await runResp.text()}`).toBe(200);
    const runBody = await runResp.json() as { job_id: string };

    const runJob = await waitForJobCompletion(request, runBody.job_id, 60_000);
    expect(runJob?.['exit_code'], 'run exit code').toBe(0);

    const releaseResp = await request.post(`/api/projects/by-project/${PROJECT}/release`);
    expect(releaseResp.status(), `release POST failed: ${await releaseResp.text()}`).toBe(200);

    const result = await waitForPipelineCompletion(request, PROJECT, 120_000);
    expect(result.status, 'pipeline timed out').toBe('done');
    expect(result.releaseJob?.['exit_code'], 'release exit code').toBe(0);

    expect(readGitBranch(PROJECT), 'current branch after zombie-branch recovery').toBe(EXPECTED_BRANCH);

    const calls = readShimCalls(PROJECT);
    const createCalls = calls.filter(
      c => !c.cmd && c.args.includes('checkout') && c.args.includes('-b') && c.args.includes(EXPECTED_BRANCH),
    );
    const deleteIndex = calls.findIndex(
      c => !c.cmd && c.args.includes('branch') && c.args.includes('-D') && c.args.includes(EXPECTED_BRANCH),
    );
    const secondCreateIndex = calls.findIndex((call, idx) =>
      idx > deleteIndex
      && !call.cmd
      && call.args.includes('checkout')
      && call.args.includes('-b')
      && call.args.includes(EXPECTED_BRANCH),
    );

    expect(createCalls, 'checkout -b was attempted twice around zombie cleanup').toHaveLength(2);
    expect(deleteIndex, 'git branch -D deleted the merged zombie ref').toBeGreaterThanOrEqual(0);
    expect(secondCreateIndex, 'git checkout -b reran after deleting the zombie branch').toBeGreaterThan(deleteIndex);
  });
});
