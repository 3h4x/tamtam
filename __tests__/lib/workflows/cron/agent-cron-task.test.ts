import { describe, it, expect, vi } from 'vitest';
import { handleAgentCron, type AgentCronDeps } from '@/lib/workflows/cron/agent-cron-task';
import type { AgentInput } from '@/lib/scheduling/agent-types';

function makeAgent(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    id: 'a1',
    name: 'workflow-rw',
    project: 'p',
    schedule: '1h',
    prompt: 'do the thing',
    enabled: true,
    ...overrides,
  } as AgentInput;
}

function makeDeps(overrides: Partial<AgentCronDeps> = {}): AgentCronDeps {
  return {
    loadAgent: vi.fn(async () => makeAgent()),
    prereqSkipReason: vi.fn(async () => null),
    startAgentRun: vi.fn(async () => 'run-xyz'),
    enqueueNextFire: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('handleAgentCron', () => {
  const NOW = 1_700_000_000_000; // fixed epoch ms

  it('dispatches the agent run and re-enqueues the next fire', async () => {
    const deps = makeDeps();
    const r = await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);
    expect(r).toMatchObject({ status: 'dispatched', runId: 'run-xyz' });
    expect(deps.startAgentRun).toHaveBeenCalledTimes(1);
    expect(deps.enqueueNextFire).toHaveBeenCalledWith('a1', expect.any(Date));
  });

  it('skips dispatch + still re-enqueues when prereq gate trips', async () => {
    const deps = makeDeps({
      prereqSkipReason: vi.fn(async () => 'project paused'),
    });
    const r = await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);
    expect(r).toMatchObject({ status: 'skipped', reason: 'project paused' });
    expect(deps.startAgentRun).not.toHaveBeenCalled();
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
  });

  it('terminates the cron chain when agent has been disabled', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn(async () => makeAgent({ enabled: false })),
    });
    const r = await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);
    expect(r.status).toBe('disabled');
    expect(deps.startAgentRun).not.toHaveBeenCalled();
    expect(deps.enqueueNextFire).not.toHaveBeenCalled();
  });

  it('terminates the cron chain when agent has been removed', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn(async () => null),
    });
    const r = await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);
    expect(r).toMatchObject({ status: 'disabled', reason: 'not found' });
    expect(deps.enqueueNextFire).not.toHaveBeenCalled();
  });

  it('uses computeNextFire output for the re-enqueue runAt', async () => {
    const deps = makeDeps();
    await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);
    const callArgs = (deps.enqueueNextFire as ReturnType<typeof vi.fn>).mock.calls[0];
    const runAt = callArgs[1] as Date;
    // 1h schedule → next fire in the future.
    expect(runAt.getTime()).toBeGreaterThan(NOW);
  });
});
