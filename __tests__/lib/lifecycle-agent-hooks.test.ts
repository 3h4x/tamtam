import { describe, it, expect, beforeEach } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import { insertJobsAndCache, makeJobRow, markDone, mocks, resetTestState, getTestDb } from './lifecycle-fixtures';

// ─── agent drain hook ─────────────────────────────────────────────────────────

describe('agent drain hook', () => {
  function makeAgentJob(id: string, kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind, prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
  });

  it('calls drainNextAgentRun with the project when an agent job finishes', async () => {
    const job = makeAgentJob('agent-done', 'agent:improve');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.drainNextAgentRun).toHaveBeenCalledOnce();
    expect(mocks.drainNextAgentRun).toHaveBeenCalledWith('proj');
  });

  it('calls drainNextAgentRun even when the agent job fails', async () => {
    const job = makeAgentJob('agent-fail-drain', 'agent:tests');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 1);

    expect(mocks.drainNextAgentRun).toHaveBeenCalledOnce();
    expect(mocks.drainNextAgentRun).toHaveBeenCalledWith('proj');
  });

  it('does NOT call drainNextAgentRun for non-agent jobs', async () => {
    const job = makeAgentJob('push-done', 'push');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    expect(mocks.drainNextAgentRun).not.toHaveBeenCalled();
  });
});

// ─── agent run failure notification ──────────────────────────────────────────

describe('agent run failure notification', () => {
  function makeAgentJob(id: string, kind: string, overrides: Partial<JobData> = {}): JobData {
    const now = Date.now() / 1000;
    return {
      id, project: 'proj', kind, prompt: null, pid: 0, logPath: null,
      startedAt: now, finishedAt: null, exitCode: null, seen: false,
      durationMs: null, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreateTokens: null, sessionId: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetTestState();
  });

  it('emits agent_run_fail notification when an agent job exits non-zero', async () => {
    const job = makeAgentJob('agent-fail', 'agent:my-agent');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 1);

    const call = mocks.notify.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'agent_run_fail',
    );
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({
      event: 'agent_run_fail',
      project: 'proj',
      agent: 'my-agent',
      job_id: 'agent-fail',
      status: 'failed',
    });
  });

  it('does NOT emit agent_run_fail when the agent job succeeds', async () => {
    const job = makeAgentJob('agent-ok', 'agent:improve');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 0);

    const failCall = mocks.notify.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'agent_run_fail',
    );
    expect(failCall).toBeUndefined();
  });

  it('does NOT emit agent_run_fail for non-agent job failures', async () => {
    const job = makeAgentJob('test-fail', 'test');
    await insertJobsAndCache(getTestDb(), [makeJobRow({ id: job.id, project: job.project, kind: job.kind })]);

    await markDone(job, 1);

    const failCall = mocks.notify.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'agent_run_fail',
    );
    expect(failCall).toBeUndefined();
  });
});
