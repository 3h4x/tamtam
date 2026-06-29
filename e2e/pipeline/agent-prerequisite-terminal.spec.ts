import { test, expect } from '@playwright/test';
import { enableProject, resetShimState, writeGitState, writeScenario, waitForJobCompletion } from './helpers';

const PROJECT = 'agent-prereq-terminal';

test.describe('Agent prerequisite terminal flow', () => {
  test.beforeEach(async ({ request }) => {
    resetShimState(PROJECT);
    // Mark worktree as committed so the dirty-worktree gate (threshold=1) doesn't
    // block the agent run. The git shim returns clean status when committed=true.
    writeGitState(PROJECT, { committed: true, pushed: false });
    await enableProject(request, PROJECT, { testsDisabled: true });
  });

  test('live terminal shows prerequisite output and the agent response proves the prompt saw it', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, [
      {
        text: 'Agent consumed prerequisite context.',
        prompt_assert_contains: [
          '## Prerequisite Output',
          'PREREQ_MARKER=alpha-123',
          'SECOND=line-two',
          'Check prerequisite forwarding from Playwright.',
        ],
        prompt_capture: [
          { label: 'marker', regex: '--- stdout ---\\nPREREQ_MARKER=([^\\n]+)' },
          { label: 'second', regex: '--- stdout ---[\\s\\S]*?\\nSECOND=([^\\n]+)' },
        ],
      },
    ]);

    const createAgentResp = await request.post('/api/agents', {
      data: {
        name: 'Prereq Echo Agent',
        project: PROJECT,
        prompt: 'Default prompt is unused here.',
        skillIds: [],
        enabled: true,
        prerequisiteCommand: "printf 'PREREQ_MARKER=alpha-123\\nSECOND=line-two\\n'",
      },
    });
    expect(createAgentResp.status()).toBe(201);
    const { agent } = await createAgentResp.json() as { agent: { id: string } };

    const runResp = await request.post(`/api/agents/${agent.id}/run`, {
      data: { prompt: 'Check prerequisite forwarding from Playwright.' },
    });
    expect(runResp.status(), await runResp.text()).toBe(200);
    const runBody = await runResp.json() as { job_id: string };

    await page.goto(`/project/${PROJECT}/terminal?job=${encodeURIComponent(runBody.job_id)}`);
    const terminal = page.locator('main');
    await expect(page.getByRole('heading', { name: /prerequisite: printf .*PREREQ_MARKER=alpha-123/i }).first()).toBeVisible({ timeout: 20_000 });
    await expect(terminal).toContainText('PREREQ_MARKER=alpha-123', { timeout: 20_000 });
    await expect(terminal).toContainText('SECOND=line-two', { timeout: 20_000 });
    await expect(terminal).toContainText('prerequisite finished — exit 0', { timeout: 20_000 });
    await expect(terminal).toContainText('Agent consumed prerequisite context.', { timeout: 20_000 });
    await expect(terminal).toContainText('marker: alpha-123', { timeout: 20_000 });
    await expect(terminal).toContainText('second: line-two', { timeout: 20_000 });

    const job = await waitForJobCompletion(request, runBody.job_id, 30_000);
    expect(job?.['exit_code']).toBe(0);
  });

  test('non-zero prerequisite still reaches the agent and stays inspectable in terminal', async ({
    page,
    request,
  }) => {
    writeScenario(PROJECT, [
      {
        text: 'Agent saw the failing prerequisite and kept going.',
        prompt_assert_contains: [
          'Exit code: 7',
          'FAIL_STDOUT=line-zero',
          'FAIL_STDERR=line-seven',
          'Check failing prerequisite forwarding.',
        ],
        prompt_capture: [
          { label: 'stdout', regex: '--- stdout ---\\nFAIL_STDOUT=([^\\n]+)' },
          { label: 'stderr', regex: '--- stderr ---\\nFAIL_STDERR=([^\\n]+)' },
          { label: 'exit', regex: 'Exit code: ([0-9]+)' },
        ],
      },
    ]);

    const createAgentResp = await request.post('/api/agents', {
      data: {
        name: 'Prereq Fail Agent',
        project: PROJECT,
        prompt: 'Default prompt is unused here.',
        skillIds: [],
        enabled: true,
        prerequisiteCommand: "printf 'FAIL_STDOUT=line-zero\\n'; printf 'FAIL_STDERR=line-seven\\n' >&2; exit 7",
      },
    });
    expect(createAgentResp.status()).toBe(201);
    const { agent } = await createAgentResp.json() as { agent: { id: string } };

    const runResp = await request.post(`/api/agents/${agent.id}/run`, {
      data: { prompt: 'Check failing prerequisite forwarding.' },
    });
    expect(runResp.status(), await runResp.text()).toBe(200);
    const runBody = await runResp.json() as { job_id: string };

    await page.goto(`/project/${PROJECT}/terminal?job=${encodeURIComponent(runBody.job_id)}`);
    const terminal = page.locator('main');
    await expect(terminal).toContainText('FAIL_STDOUT=line-zero', { timeout: 20_000 });
    await expect(terminal).toContainText('FAIL_STDERR=line-seven', { timeout: 20_000 });
    await expect(terminal).toContainText('prerequisite finished — exit 7', { timeout: 20_000 });
    await expect(terminal).toContainText('Agent saw the failing prerequisite and kept going.', { timeout: 20_000 });
    await expect(terminal).toContainText('stdout: line-zero', { timeout: 20_000 });
    await expect(terminal).toContainText('stderr: line-seven', { timeout: 20_000 });
    await expect(terminal).toContainText('exit: 7', { timeout: 20_000 });

    const job = await waitForJobCompletion(request, runBody.job_id, 30_000);
    expect(job?.['exit_code']).toBe(0);
  });
});
