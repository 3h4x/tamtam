import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  enqueueAgentRun,
  dequeueNextAgentRun,
  listQueuedAgents,
  clearProjectQueue,
  clearAllQueues,
  drainNextAgentRun,
  tryClaimAgentStartSlot,
  releaseAgentStartSlot,
  hasAgentStartSlot,
} from '@/lib/agents/pending-agent-run';

describe('pending-agent-run queue', () => {
  beforeEach(() => clearAllQueues());

  it('enqueues and dequeues in FIFO order', () => {
    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });
    enqueueAgentRun('p1', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: '', enqueuedAt: 2 });
    enqueueAgentRun('p1', { agentId: 'c', agentName: 'C', triggeredBy: 'manual', prompt: 'x', enqueuedAt: 3 });

    expect(dequeueNextAgentRun('p1')?.agentId).toBe('a');
    expect(dequeueNextAgentRun('p1')?.agentId).toBe('b');
    expect(dequeueNextAgentRun('p1')?.agentId).toBe('c');
    expect(dequeueNextAgentRun('p1')).toBeNull();
  });

  it('keeps queues separate per project', () => {
    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });
    enqueueAgentRun('p2', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: '', enqueuedAt: 2 });
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);
    expect(listQueuedAgents('p2').map((e) => e.agentId)).toEqual(['b']);
  });

  it('idempotent re-enqueue updates prompt without duplicating slot', () => {
    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: 'first', enqueuedAt: 1 });
    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'manual', prompt: 'second', enqueuedAt: 2 });
    const queued = listQueuedAgents('p1');
    expect(queued).toHaveLength(1);
    expect(queued[0].prompt).toBe('second');
    expect(queued[0].triggeredBy).toBe('manual');
  });

  it('preserves position of non-conflicting entries when one is updated', () => {
    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: 'pa', enqueuedAt: 1 });
    enqueueAgentRun('p1', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: 'pb', enqueuedAt: 2 });
    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: 'pa-2', enqueuedAt: 3 });
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a', 'b']);
    expect(listQueuedAgents('p1')[0].prompt).toBe('pa-2');
  });

  it('clearProjectQueue empties one project without touching others', () => {
    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });
    enqueueAgentRun('p2', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: '', enqueuedAt: 2 });
    clearProjectQueue('p1');
    expect(listQueuedAgents('p1')).toEqual([]);
    expect(listQueuedAgents('p2')).toHaveLength(1);
  });

  it('returns empty list for unknown project', () => {
    expect(listQueuedAgents('never-seen')).toEqual([]);
    expect(dequeueNextAgentRun('never-seen')).toBeNull();
  });
});

describe('agent start slot', () => {
  it('first claim wins, second concurrent claim is rejected with the holder name', () => {
    expect(tryClaimAgentStartSlot('p1', 'improve')).toEqual({ ok: true });
    expect(tryClaimAgentStartSlot('p1', 'docs-md')).toEqual({ ok: false, runningAgent: 'improve' });
    releaseAgentStartSlot('p1');
  });

  it('release frees the slot for the next claim', () => {
    expect(tryClaimAgentStartSlot('p1', 'a')).toEqual({ ok: true });
    releaseAgentStartSlot('p1');
    expect(tryClaimAgentStartSlot('p1', 'b')).toEqual({ ok: true });
    releaseAgentStartSlot('p1');
  });

  it('slots are independent per project', () => {
    expect(tryClaimAgentStartSlot('p1', 'a')).toEqual({ ok: true });
    expect(tryClaimAgentStartSlot('p2', 'a')).toEqual({ ok: true });
    releaseAgentStartSlot('p1');
    releaseAgentStartSlot('p2');
  });

  it('same-agent racing claim sees its own name as the holder', () => {
    expect(tryClaimAgentStartSlot('p1', 'improve')).toEqual({ ok: true });
    expect(tryClaimAgentStartSlot('p1', 'improve')).toEqual({ ok: false, runningAgent: 'improve' });
    releaseAgentStartSlot('p1');
  });

  it('clearAllQueues clears held start slots too', () => {
    expect(tryClaimAgentStartSlot('p1', 'improve')).toEqual({ ok: true });
    expect(hasAgentStartSlot('p1')).toBe(true);
    clearAllQueues();
    expect(hasAgentStartSlot('p1')).toBe(false);
  });

  it('keeps start slots visible across module reloads', async () => {
    clearAllQueues();
    const first = await import('@/lib/agents/pending-agent-run');
    expect(first.tryClaimAgentStartSlot('p-global', 'Prereq Agent')).toEqual({ ok: true });

    vi.resetModules();
    const second = await import('@/lib/agents/pending-agent-run');

    expect(second.hasAgentStartSlot('p-global')).toBe(true);
    expect(second.tryClaimAgentStartSlot('p-global', 'Other Agent')).toEqual({
      ok: false,
      runningAgent: 'Prereq Agent',
    });
    second.releaseAgentStartSlot('p-global');
  });
});

describe('drainNextAgentRun', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const textResponse = (body = '', status = 200) => new Response(body, { status });
  const jsonResponse = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    clearAllQueues();
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue(textResponse('', 200));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('no-op when queue is empty', async () => {
    await drainNextAgentRun('p1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not dispatch while the project start slot is still held', async () => {
    expect(tryClaimAgentStartSlot('p1', 'A')).toEqual({ ok: true });
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });

    await drainNextAgentRun('p1');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);
    releaseAgentStartSlot('p1');
  });

  it('POSTs to the agent run endpoint with original triggeredBy and prompt', async () => {
    enqueueAgentRun('p1', {
      agentId: 'agent-uuid-1',
      agentName: 'improve',
      triggeredBy: 'schedule',
      prompt: 'do the thing',
      enqueuedAt: 1,
    });
    await drainNextAgentRun('p1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/agents\/agent-uuid-1\/run$/);
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-tamtam-trigger']).toBe('schedule');
    expect(JSON.parse(opts.body).prompt).toBe('do the thing');
  });

  it('removes the entry from the queue after dispatch', async () => {
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });
    await drainNextAgentRun('p1');
    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('keeps the head entry queued on 202 when another agent is still running', async () => {
    fetchSpy.mockResolvedValueOnce(textResponse('Agent queued behind running blocker', 202));
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });

    await drainNextAgentRun('p1');

    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);
  });

  it('dispatches a head preserved by 202-running once the blocker clears', async () => {
    fetchSpy
      .mockResolvedValueOnce(textResponse('Agent queued behind running blocker', 202))
      .mockResolvedValueOnce(textResponse('', 200));
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });

    await drainNextAgentRun('p1');
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);

    await drainNextAgentRun('p1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('keeps the head entry queued on 202 when another agent is still starting', async () => {
    fetchSpy.mockResolvedValueOnce(textResponse('Agent queued behind starting blocker', 202));
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });

    await drainNextAgentRun('p1');

    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);
  });

  it('dispatches a head preserved by 202-starting once the blocker clears', async () => {
    fetchSpy
      .mockResolvedValueOnce(textResponse('Agent queued behind starting blocker', 202))
      .mockResolvedValueOnce(textResponse('', 200));
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });

    await drainNextAgentRun('p1');
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);

    await drainNextAgentRun('p1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('hands the head to the DB queue on 202 pending_release', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'pending_release',
          detail: 'Pending release will run before new agent work',
        },
        202,
      )
    );
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });

    await drainNextAgentRun('p1');

    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('keeps the head entry queued on transient 409 (already_starting / already_running)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ code: 'already_starting', detail: 'Agent is already starting' }, 409)
    );
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });

    await drainNextAgentRun('p1');

    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);
  });

  it('keeps the head entry queued on transient 409 project_busy and drains it after retrying later', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: 'project_busy',
            detail: "Job 'run' is already running for p1 (job run-123)",
            blockingJobId: 'run-123',
          },
          409,
        )
      )
      .mockResolvedValueOnce(textResponse('', 200));

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });

    await drainNextAgentRun('p1');
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);

    await drainNextAgentRun('p1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('keeps the head entry queued on a transient 500 replay failure and drains it after retrying later', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(
          {
            detail: 'Failed to start: pm2 start failed',
          },
          500,
        )
      )
      .mockResolvedValueOnce(textResponse('', 200));

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });

    await drainNextAgentRun('p1');
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);

    await drainNextAgentRun('p1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('drops the head and lets a later valid entry drain when 409 reports agent_disabled', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ code: 'agent_disabled', detail: "Agent 'A' is disabled" }, 409)
      )
      .mockResolvedValueOnce(textResponse('', 200));

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });
    enqueueAgentRun('p1', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: '', enqueuedAt: 2 });

    await drainNextAgentRun('p1');
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['b']);

    await drainNextAgentRun('p1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('drops the head when 409 reports no_schedule', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ code: 'no_schedule', detail: "Agent 'A' has no schedule" }, 409)
    );

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });
    enqueueAgentRun('p1', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: '', enqueuedAt: 2 });

    await drainNextAgentRun('p1');

    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['b']);
  });

  it('drops the head when 409 reports issue_branch', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ code: 'issue_branch', detail: 'Cannot run agent on issue branch' }, 409)
    );

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });
    enqueueAgentRun('p1', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: '', enqueuedAt: 2 });

    await drainNextAgentRun('p1');

    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['b']);
  });

  it('keeps the head when 409 reports jobs_paused and drains it after retrying later', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ code: 'jobs_paused', detail: 'Jobs are paused globally. Turn the switch back on in Settings to start an agent run.' }, 409)
      )
      .mockResolvedValueOnce(textResponse('', 200));

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });

    await drainNextAgentRun('p1');
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);

    await drainNextAgentRun('p1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('drops the head on an unknown 409 (no code) so later entries can drain', async () => {
    fetchSpy.mockResolvedValueOnce(textResponse('plain text 409 with no code field', 409));

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });
    enqueueAgentRun('p1', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: '', enqueuedAt: 2 });

    await drainNextAgentRun('p1');

    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['b']);
  });

  it('keeps the head on 429 and retries it on a timer', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: 'providers_over_budget',
            detail: 'All enabled CLI providers are over budget. Adjust block threshold or wait for the window to reset.',
          },
          429,
        )
      )
      .mockResolvedValueOnce(textResponse('', 200));

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });

    await drainNextAgentRun('p1');
    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['a']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('drops the head on terminal 400 so later entries can drain', async () => {
    fetchSpy.mockResolvedValueOnce(textResponse('agent has no prompt and no skills to run', 400));

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });
    enqueueAgentRun('p1', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: '', enqueuedAt: 2 });

    await drainNextAgentRun('p1');

    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['b']);
  });

  it('drops the head on terminal 404 so later entries can drain', async () => {
    fetchSpy.mockResolvedValueOnce(textResponse('agent not found', 404));

    enqueueAgentRun('p1', { agentId: 'a', agentName: 'A', triggeredBy: 'schedule', prompt: '', enqueuedAt: 1 });
    enqueueAgentRun('p1', { agentId: 'b', agentName: 'B', triggeredBy: 'schedule', prompt: '', enqueuedAt: 2 });

    await drainNextAgentRun('p1');

    expect(listQueuedAgents('p1').map((e) => e.agentId)).toEqual(['b']);
  });

  it('dispatches the preserved head after the slot is released', async () => {
    expect(tryClaimAgentStartSlot('p1', 'A')).toEqual({ ok: true });
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });

    await drainNextAgentRun('p1');
    expect(fetchSpy).not.toHaveBeenCalled();

    releaseAgentStartSlot('p1');
    await drainNextAgentRun('p1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(listQueuedAgents('p1')).toEqual([]);
  });

  it('logs (does not throw) when fetch rejects', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    enqueueAgentRun('p1', {
      agentId: 'a',
      agentName: 'A',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });
    await expect(drainNextAgentRun('p1')).resolves.toBeUndefined();
  });

  it('encodes file-agent ids correctly in the URL', async () => {
    enqueueAgentRun('p1', {
      agentId: 'file:my-proj:cto',
      agentName: 'cto',
      triggeredBy: 'schedule',
      prompt: '',
      enqueuedAt: 1,
    });
    await drainNextAgentRun('p1');
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('file%3Amy-proj%3Acto');
  });
});
