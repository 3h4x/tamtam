import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

const mocks = vi.hoisted(() => ({
  handle: null as TestDbHandle | null,
  dispatchReleaseWorkflow: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  get db() {
    return mocks.handle!.db;
  },
  schema,
}));

vi.mock('@/lib/workflows/dispatch-release', () => ({
  dispatchReleaseWorkflow: (...args: unknown[]) => mocks.dispatchReleaseWorkflow(...args),
}));

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS queued_agent_runs (
      id serial PRIMARY KEY,
      project text NOT NULL,
      agent_id text NOT NULL,
      agent_name text NOT NULL,
      triggered_by text NOT NULL DEFAULT 'manual',
      prompt text NOT NULL DEFAULT '',
      enqueued_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS queued_agent_runs_project_agent
      ON queued_agent_runs (project, agent_id)
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS pipeline_locks (
      project text PRIMARY KEY,
      locked_by_job_id text NOT NULL,
      acquired_at double precision NOT NULL
    )
  `));
}

describe('/api/automation-queue', () => {
  let GET: typeof import('@/app/api/automation-queue/route').GET;
  let retryPost: typeof import('@/app/api/automation-queue/retry/route').POST;
  let cancelPost: typeof import('@/app/api/automation-queue/cancel/route').POST;

  beforeAll(async () => {
    mocks.handle = await createTestPgDbEmpty();
    await applyDdl(mocks.handle);

    ({ GET } = await import('@/app/api/automation-queue/route'));
    ({ POST: retryPost } = await import('@/app/api/automation-queue/retry/route'));
    ({ POST: cancelPost } = await import('@/app/api/automation-queue/cancel/route'));
  });

  beforeEach(async () => {
    await mocks.handle!.db.execute(sql.raw('TRUNCATE settings, queued_agent_runs, pipeline_locks RESTART IDENTITY'));
    globalThis.__tamtamProjectRecoveryDrains?.clear();
    mocks.dispatchReleaseWorkflow.mockReset();
    mocks.dispatchReleaseWorkflow.mockResolvedValue({ ok: true, jobId: 'release-1' });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await mocks.handle?.[Symbol.asyncDispose]();
    mocks.handle = null;
  });

  it('lists pending releases and queued agent runs for a project', async () => {
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO settings (key, value) VALUES ('pending_release:proj', '1710000000')
    `));
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO queued_agent_runs (project, agent_id, agent_name, triggered_by, prompt, enqueued_at)
      VALUES ('proj', 'agent-1', 'Review Agent', 'release-lock', 'go', 1710000010)
    `));
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at)
      VALUES ('proj', 'release-lock-1', 9999999999)
    `));

    const res = await GET(new NextRequest('http://localhost/api/automation-queue?project=proj'));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toEqual([
      expect.objectContaining({
        id: 'pending_release:proj',
        project: 'proj',
        kind: 'pending_release',
        code: 'pipeline_lock',
        queuedAt: 1710000000000,
        blockingJobId: 'release-lock-1',
        retryAllowed: true,
        cancelAllowed: true,
      }),
      expect.objectContaining({
        id: 'queued_agent_run:1',
        project: 'proj',
        kind: 'queued_agent_run',
        agentId: 'agent-1',
        agentName: 'Review Agent',
        code: 'pending_release',
        queuedAt: 1710000010000,
      }),
    ]);
  });

  it('cancels a pending release flag without touching queued agents', async () => {
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO settings (key, value) VALUES ('pending_release:proj', '1710000000')
    `));
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO queued_agent_runs (project, agent_id, agent_name, triggered_by, prompt, enqueued_at)
      VALUES ('proj', 'agent-1', 'Review Agent', 'release-lock', 'go', 1710000010)
    `));

    const res = await cancelPost(new NextRequest('http://localhost/api/automation-queue/cancel', {
      method: 'POST',
      body: JSON.stringify({ kind: 'pending_release', project: 'proj', id: 'pending_release:proj' }),
    }));

    expect(res.status).toBe(200);
    const settings = await mocks.handle!.db.execute(sql.raw('SELECT * FROM settings'));
    const queued = await mocks.handle!.db.execute(sql.raw('SELECT * FROM queued_agent_runs'));
    expect(settings.rows).toHaveLength(0);
    expect(queued.rows).toHaveLength(1);
  });

  it('does not report pending release cancellation success when the delete fails', async () => {
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO settings (key, value) VALUES ('pending_release:proj', '1710000000')
    `));
    vi.spyOn(mocks.handle!.db, 'delete').mockImplementationOnce(() => {
      throw new Error('delete failed');
    });

    const res = await cancelPost(new NextRequest('http://localhost/api/automation-queue/cancel', {
      method: 'POST',
      body: JSON.stringify({ kind: 'pending_release', project: 'proj', id: 'pending_release:proj' }),
    }));

    expect(res.status).toBe(500);
    const settings = await mocks.handle!.db.execute(sql.raw('SELECT * FROM settings'));
    expect(settings.rows).toHaveLength(1);
  });

  it('cancels a queued agent row without affecting active jobs or release flags', async () => {
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO settings (key, value) VALUES ('pending_release:proj', '1710000000')
    `));
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO queued_agent_runs (project, agent_id, agent_name, triggered_by, prompt, enqueued_at)
      VALUES ('proj', 'agent-1', 'Review Agent', 'release-lock', 'go', 1710000010)
    `));

    const res = await cancelPost(new NextRequest('http://localhost/api/automation-queue/cancel', {
      method: 'POST',
      body: JSON.stringify({ kind: 'queued_agent_run', project: 'proj', id: '1' }),
    }));

    expect(res.status).toBe(200);
    const settings = await mocks.handle!.db.execute(sql.raw('SELECT * FROM settings'));
    const queued = await mocks.handle!.db.execute(sql.raw('SELECT * FROM queued_agent_runs'));
    expect(settings.rows).toHaveLength(1);
    expect(queued.rows).toHaveLength(0);
  });

  it('retries through the recovery drain and reports started work', async () => {
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO settings (key, value) VALUES ('pending_release:proj', '1710000000')
    `));

    const res = await retryPost(new NextRequest('http://localhost/api/automation-queue/retry', {
      method: 'POST',
      body: JSON.stringify({ project: 'proj' }),
    }));

    expect(res.status).toBe(200);
    expect(mocks.dispatchReleaseWorkflow).toHaveBeenCalledWith('proj');
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.items).toEqual([]);
  });

  it('does not let concurrent retry drain queued agents ahead of a pending release', async () => {
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO settings (key, value) VALUES ('pending_release:proj', '1710000000')
    `));
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO queued_agent_runs (project, agent_id, agent_name, triggered_by, prompt, enqueued_at)
      VALUES ('proj', 'agent-1', 'Review Agent', 'release-lock', 'go', 1710000010)
    `));

    let resolveRelease!: (value: { ok: true; jobId: string }) => void;
    mocks.dispatchReleaseWorkflow.mockImplementation(() => new Promise((resolve) => {
      resolveRelease = resolve;
    }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'started' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = retryPost(new NextRequest('http://localhost/api/automation-queue/retry', {
      method: 'POST',
      body: JSON.stringify({ project: 'proj' }),
    }));

    await vi.waitFor(() => {
      expect(mocks.dispatchReleaseWorkflow).toHaveBeenCalledWith('proj');
    });

    const second = retryPost(new NextRequest('http://localhost/api/automation-queue/retry', {
      method: 'POST',
      body: JSON.stringify({ project: 'proj' }),
    }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();

    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO pipeline_locks (project, locked_by_job_id, acquired_at)
      VALUES ('proj', 'release-lock-1', ${Date.now() / 1000})
    `));
    resolveRelease({ ok: true, jobId: 'release-1' });

    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(mocks.dispatchReleaseWorkflow).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const queued = await mocks.handle!.db.execute(sql.raw('SELECT * FROM queued_agent_runs'));
    expect(queued.rows).toHaveLength(1);
  });

  it('reports started and does not replay a consumed queued agent after successful retry', async () => {
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO queued_agent_runs (project, agent_id, agent_name, triggered_by, prompt, enqueued_at)
      VALUES ('proj', 'agent-1', 'Review Agent', 'release-lock', 'go', 1710000010)
    `));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'started' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await retryPost(new NextRequest('http://localhost/api/automation-queue/retry', {
      method: 'POST',
      body: JSON.stringify({ project: 'proj' }),
    }));
    const second = await retryPost(new NextRequest('http://localhost/api/automation-queue/retry', {
      method: 'POST',
      body: JSON.stringify({ project: 'proj' }),
    }));

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'started', items: [] });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'empty', items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const queued = await mocks.handle!.db.execute(sql.raw('SELECT * FROM queued_agent_runs'));
    expect(queued.rows).toHaveLength(0);
  });

  it('reports started and does not replay a queued agent handed off to the in-memory queue', async () => {
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO queued_agent_runs (project, agent_id, agent_name, triggered_by, prompt, enqueued_at)
      VALUES ('proj', 'agent-1', 'Review Agent', 'release-lock', 'go', 1710000010)
    `));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'queued',
      detail: 'same-project agent queue accepted the run',
    }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await retryPost(new NextRequest('http://localhost/api/automation-queue/retry', {
      method: 'POST',
      body: JSON.stringify({ project: 'proj' }),
    }));
    const second = await retryPost(new NextRequest('http://localhost/api/automation-queue/retry', {
      method: 'POST',
      body: JSON.stringify({ project: 'proj' }),
    }));

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'started', items: [] });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'empty', items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const queued = await mocks.handle!.db.execute(sql.raw('SELECT * FROM queued_agent_runs'));
    expect(queued.rows).toHaveLength(0);
  });

  it('keeps queued agent rows when retry is still blocked by the run endpoint', async () => {
    await mocks.handle!.db.execute(sql.raw(`
      INSERT INTO queued_agent_runs (project, agent_id, agent_name, triggered_by, prompt, enqueued_at)
      VALUES ('proj', 'agent-1', 'Review Agent', 'release-lock', 'go', 1710000010)
    `));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'queued',
      code: 'pipeline_lock',
      detail: 'release still running',
    }), { status: 202 })));

    const res = await retryPost(new NextRequest('http://localhost/api/automation-queue/retry', {
      method: 'POST',
      body: JSON.stringify({ project: 'proj' }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('stayed_queued');
    expect(data.items).toEqual([
      expect.objectContaining({ kind: 'queued_agent_run', agentId: 'agent-1' }),
    ]);
  });
});
