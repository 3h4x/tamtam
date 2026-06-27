import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDb, type TestDbHandle } from '@/__tests__/helpers/test-db';

let sharedHandle: TestDbHandle;

vi.mock('@/lib/db', () => ({
  get db() {
    return sharedHandle.db;
  },
  get schema() {
    return schema;
  },
}));

// drainNextTerminalRun dynamically imports findBlockingRunningJob and replays
// the head through the run route via global fetch — mock both so the drain's
// status-branching is exercised in isolation.
const blocking = vi.hoisted(() => ({
  findBlockingRunningJob: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/jobs/project-active-job', () => ({
  findBlockingRunningJob: (...args: unknown[]) => blocking.findBlockingRunningJob(...args),
}));

import {
  enqueueTerminalRun,
  listQueuedTerminalRuns,
  hasPendingTerminalRun,
  getQueuedTerminalRun,
  markQueuedTerminalRunStarted,
  cancelQueuedTerminalRun,
  listQueuedTerminalRunProjects,
  drainNextTerminalRun,
} from '@/lib/terminal/pending-terminal-run';

function fakeResponse(init: { ok: boolean; status: number; jobId?: string; body?: string }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => (init.jobId !== undefined ? { job_id: init.jobId } : {}),
    text: async () => init.body ?? '',
  } as unknown as Response;
}

beforeAll(async () => {
  sharedHandle = await createTestPgDb();
});

afterAll(async () => {
  await sharedHandle[Symbol.asyncDispose]();
});

beforeEach(async () => {
  await sharedHandle.db.execute(sql`DELETE FROM queued_terminal_runs`);
  blocking.findBlockingRunningJob.mockReset().mockResolvedValue(null);
  vi.unstubAllGlobals();
});

describe('pending-terminal-run queue', () => {
  it('enqueues and lists FIFO by enqueue order', async () => {
    const a = await enqueueTerminalRun('proj', { prompt: 'first' });
    const b = await enqueueTerminalRun('proj', { prompt: 'second' });

    expect(a.position).toBe(1);
    expect(b.position).toBe(2);

    const pending = await listQueuedTerminalRuns('proj');
    expect(pending.map((e) => e.payload.prompt)).toEqual(['first', 'second']);
    expect(pending.map((e) => e.id)).toEqual([a.queueId, b.queueId]);
  });

  it('round-trips the full payload', async () => {
    const { queueId } = await enqueueTerminalRun('proj', {
      prompt: 'do it',
      userPrompt: 'do it',
      model: 'smart',
      provider: 'claude',
      permissionMode: 'plan',
      resumeSessionId: 'sess-1',
      personas: ['reviewer'],
      attachmentPaths: ['/data/attachments/abc.txt'],
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
    });
    const entry = await getQueuedTerminalRun(queueId);
    expect(entry?.payload).toMatchObject({
      prompt: 'do it',
      model: 'smart',
      provider: 'claude',
      permissionMode: 'plan',
      resumeSessionId: 'sess-1',
      personas: ['reviewer'],
      attachmentPaths: ['/data/attachments/abc.txt'],
      ghIssueNumber: 7,
      ghIssueRepo: 'owner/repo',
    });
    expect(entry?.status).toBe('pending');
  });

  it('hasPendingTerminalRun and listQueuedTerminalRunProjects are scoped per project', async () => {
    await enqueueTerminalRun('alpha', { prompt: 'x' });
    expect(await hasPendingTerminalRun('alpha')).toBe(true);
    expect(await hasPendingTerminalRun('beta')).toBe(false);
    expect((await listQueuedTerminalRunProjects()).sort()).toEqual(['alpha']);
  });

  it('cancel removes a pending entry and returns whether it existed', async () => {
    const { queueId } = await enqueueTerminalRun('proj', { prompt: 'cancel me' });
    expect(await cancelQueuedTerminalRun(queueId)).toBe(true);
    expect(await getQueuedTerminalRun(queueId)).toBeNull();
    expect(await cancelQueuedTerminalRun(queueId)).toBe(false);
    expect(await hasPendingTerminalRun('proj')).toBe(false);
  });
});

describe('drainNextTerminalRun', () => {
  it('leaves the head pending and does not replay when the project is still blocked', async () => {
    const { queueId } = await enqueueTerminalRun('proj', { prompt: 'blocked' });
    blocking.findBlockingRunningJob.mockResolvedValue({ id: 'job-1', kind: 'release' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await drainNextTerminalRun('proj');

    expect(fetchSpy).not.toHaveBeenCalled();
    const entry = await getQueuedTerminalRun(queueId);
    expect(entry?.status).toBe('pending');
  });

  it('marks the head started with the returned job id on a successful replay', async () => {
    const { queueId } = await enqueueTerminalRun('proj', { prompt: 'go' });
    const fetchSpy = vi.fn().mockImplementation(async () => {
      await markQueuedTerminalRunStarted(queueId, 'proj', 'job-42');
      return fakeResponse({ ok: true, status: 200, jobId: 'job-42' });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await drainNextTerminalRun('proj');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const entry = await getQueuedTerminalRun(queueId);
    expect(entry?.status).toBe('started');
    expect(entry?.startedJobId).toBe('job-42');
  });

  it('does not leave the head pending when the replay times out after the route claimed it', async () => {
    const { queueId } = await enqueueTerminalRun('proj', { prompt: 'go' });
    const fetchSpy = vi.fn().mockImplementation(async () => {
      await markQueuedTerminalRunStarted(queueId, 'proj', 'job-42');
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await drainNextTerminalRun('proj');
    await drainNextTerminalRun('proj');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const entry = await getQueuedTerminalRun(queueId);
    expect(entry?.status).toBe('started');
    expect(entry?.startedJobId).toBe('job-42');
  });

  it.each([409, 429, 500, 503])('keeps the head pending on a transient %d replay', async (status) => {
    const { queueId } = await enqueueTerminalRun('proj', { prompt: 'retry me' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ ok: false, status, body: 'busy' })));

    await drainNextTerminalRun('proj');

    const entry = await getQueuedTerminalRun(queueId);
    expect(entry?.status).toBe('pending');
  });

  it.each([400, 404])('drops the head on a terminal %d replay', async (status) => {
    const { queueId } = await enqueueTerminalRun('proj', { prompt: 'unrunnable' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ ok: false, status, body: 'bad' })));

    await drainNextTerminalRun('proj');

    expect(await getQueuedTerminalRun(queueId)).toBeNull();
    expect(await hasPendingTerminalRun('proj')).toBe(false);
  });

  it('replays only once under concurrent (re-entrant) drains', async () => {
    await enqueueTerminalRun('proj', { prompt: 'once' });
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 200, jobId: 'job-1' }));
    vi.stubGlobal('fetch', fetchSpy);

    // Both kicked before the first awaits its fetch; the in-flight guard must
    // make the second a no-op so the head is replayed exactly once.
    await Promise.all([drainNextTerminalRun('proj'), drainNextTerminalRun('proj')]);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('no-ops when nothing is queued', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await drainNextTerminalRun('proj');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(blocking.findBlockingRunningJob).not.toHaveBeenCalled();
  });
});
