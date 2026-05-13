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
} from './helpers';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, 'scenarios', 'issue-release-auto-branch.json'), 'utf-8'),
);

const PROJECT = 'issue-release-auto-branch';
const ISSUE_NUMBER = 42;
const ISSUE_TITLE = 'Test issue';
const EXPECTED_BRANCH = 'fix/issue-42-test-issue';

test.describe('Issue-linked release auto-branching', () => {
  test.beforeAll(async ({ request }) => {
    writeScenario(PROJECT, SCENARIO.steps);
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, {
      testsDisabled: true,
      autoPushEnabled: true,
    });
  });

  test('creates the derived feature branch before commit and keeps PR creation on that branch', async ({ request }) => {
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

    expect(readGitBranch(PROJECT), 'current branch after push stays on derived issue branch').toBe(EXPECTED_BRANCH);

    const calls = readShimCalls(PROJECT);
    const checkoutCreateCall = calls.find(
      c => !c.cmd && c.args.includes('checkout') && c.args.includes('-b') && c.args.includes(EXPECTED_BRANCH),
    );
    expect(checkoutCreateCall, 'git checkout -b created the derived issue branch').toBeTruthy();

    const prCreateCall = calls.find(
      c => c.cmd === 'gh' && c.args.includes('pr') && c.args.includes('create'),
    );
    expect(prCreateCall, 'gh pr create was invoked for the issue branch').toBeTruthy();
  });
});
