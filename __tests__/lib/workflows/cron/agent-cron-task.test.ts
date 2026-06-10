import { describe, it, expect, vi } from 'vitest';
import { createAgentCronTask, handleAgentCron, type AgentCronDeps } from '@/lib/workflows/cron/agent-cron-task';
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

  it('retries a not-found agent on a short window instead of terminating the chain', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn(async () => null),
    });
    const r = await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);
    expect(r.status).toBe('skipped');
    expect(deps.startAgentRun).not.toHaveBeenCalled();
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
    const [agentId, runAt, payloadOverride] = (deps.enqueueNextFire as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(agentId).toBe('a1');
    expect((runAt as Date).getTime()).toBe(NOW + 60_000);
    expect(payloadOverride).toMatchObject({ agentId: 'a1', notFoundRetries: 1 });
  });

  it('increments the not-found retry counter across consecutive misses', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn(async () => null),
    });
    const r = await handleAgentCron({ agentId: 'a1', notFoundRetries: 1 }, deps, () => NOW);
    expect(r.status).toBe('skipped');
    const [, , payloadOverride] = (deps.enqueueNextFire as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payloadOverride).toMatchObject({ agentId: 'a1', notFoundRetries: 2 });
  });

  it('terminates the cron chain when agent stays missing after retries are exhausted', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn(async () => null),
    });
    const r = await handleAgentCron({ agentId: 'a1', notFoundRetries: 3 }, deps, () => NOW);
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

  it('dispatches kind=system agents to the system handler, not the user CLI path', async () => {
    const systemHandler = vi.fn(async () => undefined);
    const deps = makeDeps({
      loadAgent: vi.fn(async () => makeAgent({ kind: 'system' })),
      runSystemAgent: systemHandler,
    });
    const r = await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);
    expect(r).toMatchObject({ status: 'dispatched', reason: 'system' });
    expect(systemHandler).toHaveBeenCalledTimes(1);
    expect(deps.startAgentRun).not.toHaveBeenCalled();
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
  });

  it('skips a system agent fire (without breaking the chain) when no handler is bound', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn(async () => makeAgent({ kind: 'system' })),
      runSystemAgent: undefined,
    });
    const r = await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);
    expect(r).toMatchObject({ status: 'skipped', reason: 'no system handler bound' });
    expect(deps.startAgentRun).not.toHaveBeenCalled();
    expect(deps.enqueueNextFire).toHaveBeenCalledTimes(1);
  });

  it('re-enqueues transient skips after the short retry window', async () => {
    const deps = makeDeps({
      prereqSkipReason: vi.fn(async () => 'jobs paused during rebuild'),
    });

    const r = await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);

    expect(r).toMatchObject({ status: 'skipped', reason: 'jobs paused during rebuild' });
    const callArgs = (deps.enqueueNextFire as ReturnType<typeof vi.fn>).mock.calls[0];
    const runAt = callArgs[1] as Date;
    expect(runAt.getTime()).toBe(NOW + 60_000);
  });

  it('terminates the cron chain when the schedule has been cleared', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn(async () => makeAgent({ schedule: null })),
    });

    const r = await handleAgentCron({ agentId: 'a1' }, deps, () => NOW);

    expect(r).toMatchObject({ status: 'disabled', reason: 'no schedule' });
    expect(deps.startAgentRun).not.toHaveBeenCalled();
    expect(deps.enqueueNextFire).not.toHaveBeenCalled();
  });
});

describe('createAgentCronTask', () => {
  it('logs successful task outcomes', async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const task = createAgentCronTask(makeDeps());

    await task({ agentId: 'a1' }, { logger } as never);

    expect(logger.info).toHaveBeenCalledWith('agent-cron a1 → dispatched');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs failures and rethrows so graphile can retry', async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const task = createAgentCronTask(makeDeps({
      startAgentRun: vi.fn(async () => {
        throw new Error('boom');
      }),
    }));

    await expect(task({ agentId: 'a1' }, { logger } as never)).rejects.toThrow('boom');
    expect(logger.error).toHaveBeenCalledWith('agent-cron a1 failed: boom');
    expect(logger.info).not.toHaveBeenCalled();
  });
});
