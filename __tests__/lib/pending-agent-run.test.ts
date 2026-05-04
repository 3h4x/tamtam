import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  enqueueAgentRun,
  dequeueNextAgentRun,
  listQueuedAgents,
  clearProjectQueue,
  clearAllQueues,
  drainNextAgentRun,
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

describe('drainNextAgentRun', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearAllQueues();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no-op when queue is empty', async () => {
    await drainNextAgentRun('p1');
    expect(fetchSpy).not.toHaveBeenCalled();
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
