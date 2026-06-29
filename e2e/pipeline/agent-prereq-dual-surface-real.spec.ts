import { test, expect } from '@playwright/test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  enableProject,
  resetShimState,
  waitForJobByIdRunning,
  waitForJobCompletion,
  writeScenario,
} from './helpers';
import { SHIM_DIR } from './global-setup';

// Dual-surface lifecycle coverage for an agent that carries a
// prerequisiteCommand. agent-prerequisite-terminal.spec.ts proves the terminal
// surface forwards prereq output into the prompt, but it never looks at the
// project history/runs list and uses an instant prereq. This spec fills both
// gaps: while the prereq (and the post-prereq composition window) is in flight,
// the agent run must show as `running` on BOTH the history list and the live
// terminal, and then settle to a clean `exit 0` — never the spurious `-1` the
// probe sweep would record if the post-prerequisite pid bridge regressed (see
// the "prevent agent job loss in prereq window" fix in lib/agents/intake-workflow.ts).

const PROJECT = 'agent-prereq-dual-surface';

test.describe('Real agent prerequisite dual-surface lifecycle', () => {
  test('history and terminal both show the prereq-bearing agent running, then settle to success without reload', async ({
    page,
    request,
  }) => {
    resetShimState(PROJECT);
    // Report a clean worktree so the agent /run endpoint's dirty-worktree gate
    // (default threshold 1; global-setup seeds one fake change) doesn't 409 the
    // run. This is project-local — it avoids mutating the global
    // dirty_worktree_block_threshold setting that other parallel specs read.
    writeFileSync(
      join(SHIM_DIR, PROJECT, 'git-state.json'),
      JSON.stringify({ committed: true, pushed: false }),
    );
    writeScenario(PROJECT, [
      {
        label: 'agent',
        text: 'Agent finished after consuming the prerequisite output.',
        prompt_assert_contains: ['PREREQ_MARK=dual-surface-ok'],
      },
    ]);
    await enableProject(request, PROJECT, { testsDisabled: true });

    await page.goto(`/project/${PROJECT}/history`);
    await expect(page.getByText('No runs yet').first()).toBeVisible({ timeout: 8_000 });

    const createAgentResp = await request.post('/api/agents', {
      data: {
        name: 'Prereq Dual Surface Agent',
        project: PROJECT,
        prompt: 'Default prompt is unused here.',
        skillIds: [],
        enabled: true,
        // Print the marker immediately so the terminal can show it while the job
        // is still running, then hold the process open so both surfaces have a
        // stable window to observe the running state.
        prerequisiteCommand: "printf 'PREREQ_MARK=dual-surface-ok\\n'; sleep 3",
      },
    });
    expect(createAgentResp.status(), await createAgentResp.text()).toBe(201);
    const { agent } = await createAgentResp.json() as { agent: { id: string } };

    const runResp = await request.post(`/api/agents/${agent.id}/run`, {
      data: { prompt: 'Drive the prereq dual-surface lifecycle.' },
    });
    expect(runResp.status(), await runResp.text()).toBe(200);
    const runBody = await runResp.json() as { job_id: string };
    expect(runBody.job_id, 'agent run job_id in response').toBeTruthy();

    const runningRun = await waitForJobByIdRunning(request, runBody.job_id, 20_000);
    expect(runningRun, 'agent run should be running during the prerequisite').not.toBeNull();

    // History surface: the agent row (title is the agent name) shows the
    // running badge and the header running count, replacing the empty state.
    const runRow = page.getByRole('button').filter({
      hasText: 'Prereq Dual Surface Agent',
    }).first();
    await expect(runRow).toBeVisible({ timeout: 20_000 });
    await expect(runRow.getByLabel('running')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('1 running')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No runs yet')).toHaveCount(0, { timeout: 20_000 });

    // Terminal surface: the same live run shows its spinner, proving the job is
    // genuinely running on the second surface too. (Prerequisite-output
    // rendering is owned by agent-prerequisite-terminal.spec.ts; here we only
    // assert the shared running→done lifecycle.)
    const terminalPage = await page.context().newPage();
    await terminalPage.goto(
      `/project/${PROJECT}/terminal?job=${encodeURIComponent(runBody.job_id)}`,
    );
    const terminal = terminalPage.locator('main');
    await expect(terminalPage.getByLabel('live run spinner')).toBeVisible({ timeout: 20_000 });
    await expect(terminal).toContainText('Drive the prereq dual-surface lifecycle.', {
      timeout: 20_000,
    });

    // The job must finalize cleanly — exit 0, NOT the probe sweep's -1.
    const runJob = await waitForJobCompletion(request, runBody.job_id, 60_000);
    expect(runJob?.['exit_code'], 'prereq agent run exit code').toBe(0);

    // Both surfaces drop the live state without a reload and surface the result.
    await expect(runRow.getByLabel('done')).toBeVisible({ timeout: 15_000 });
    await expect(runRow.getByLabel('running')).toHaveCount(0, { timeout: 15_000 });
    await expect(terminal).toContainText('Agent finished after consuming the prerequisite output.', {
      timeout: 15_000,
    });
    await expect(terminalPage.getByLabel('live run spinner')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('span.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
  });
});
