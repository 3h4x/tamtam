import { test, expect } from '@playwright/test';
import { enableProject, resetShimState, writeScenario, waitForJobCompletion } from './helpers';

const PROJECT = 'issue-cruncher-prereq';

// Canned issues payload — what the prereq command would normally produce by
// hitting /api/projects/by-project/<project>/issues?trusted_only=1. Using
// printf keeps the test isolated from the issues route.
const ISSUES_JSON = JSON.stringify({
  repo: 'octo/test',
  issues: [
    {
      number: 42,
      title: 'Sample bug to fix',
      labels: [{ name: 'bug' }],
      assignees: [],
      url: 'https://example.test/issues/42',
      author: { login: 'alice' },
      body: 'Steps to reproduce: open the page and click the button.',
    },
  ],
});

test.describe('issue-cruncher prerequisite forwarding', () => {
  test.beforeEach(async ({ request }) => {
    resetShimState(PROJECT);
    await enableProject(request, PROJECT, { testsDisabled: true });
    // Default skills (including agent-issue-cruncher) are seeded lazily on the
    // first GET /api/skills. Trigger it so the skill content is in the DB
    // before the agent run composes the prompt.
    await request.get('/api/skills');
  });

  test('issue list reaches the prompt and the agent uses it instead of running gh', async ({ request }) => {
    writeScenario(PROJECT, [
      {
        text: 'Picked issue #42 from the prerequisite payload.',
        prompt_assert_contains: [
          // Skill content is composed into the prompt
          'You are the issue cruncher.',
          'Prerequisite Output',
          // Skill text directing the agent to use the prereq instead of gh
          'Read the eligible issue list from the',
          // The prereq stdout itself must be present
          '"number":42',
          'Sample bug to fix',
          'Steps to reproduce: open the page and click the button.',
          // The user-provided run prompt is still appended
          'Pick the highest-priority issue.',
        ],
        prompt_assert_not_contains: [
          // Sanity: the skill instructs NOT to call gh issue list directly
          'gh issue list --state open',
        ],
      },
    ]);

    const createAgentResp = await request.post('/api/agents', {
      data: {
        name: 'Issue Cruncher Prereq Agent',
        project: PROJECT,
        prompt: 'Default prompt is unused here.',
        skillIds: ['agent-issue-cruncher'],
        enabled: true,
        // Override the auto-generated curl prereq so we don't depend on
        // the issues route or live GitHub calls.
        prerequisiteCommand: `printf '%s' ${JSON.stringify(ISSUES_JSON)}`,
      },
    });
    expect(createAgentResp.status(), await createAgentResp.text()).toBe(201);
    const { agent } = await createAgentResp.json() as { agent: { id: string } };

    const runResp = await request.post(`/api/agents/${agent.id}/run`, {
      data: { prompt: 'Pick the highest-priority issue.' },
    });
    expect(runResp.status(), await runResp.text()).toBe(200);
    const { job_id: jobId } = await runResp.json() as { job_id: string };

    const job = await waitForJobCompletion(request, jobId, 30_000);
    expect(job, 'job did not finish in time').not.toBeNull();
    // exit_code === 0 means the shim's prompt assertions all passed.
    expect(job?.['exit_code']).toBe(0);
  });
});
