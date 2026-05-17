import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      skill_ids text NOT NULL DEFAULT '[]',
      model text NOT NULL DEFAULT 'normal',
      prompt text NOT NULL DEFAULT '',
      schedule text,
      runner text NOT NULL DEFAULT 'pm2',
      enabled boolean NOT NULL DEFAULT true,
      doc_paths text NOT NULL DEFAULT '[]',
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
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
}

describe('POST /api/agents/{agentId}/run runtime DB bootstrap', () => {
  let sharedHandle: TestDbHandle;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents, queued_agent_runs RESTART IDENTITY'));
    vi.doMock('@/lib/db', () => ({
      db: sharedHandle.db,
      schema,
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      isLockOwnedByActiveRelease: vi.fn().mockResolvedValue(true),
      getLock: vi.fn().mockResolvedValue({ project: 'proj1', lockedByJobId: 'release-1' }),
    }));
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 10));
    vi.doUnmock('@/lib/pipeline/pipeline-lock');
    vi.doUnmock('@/lib/db');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('queues behind an active release on a freshly bootstrapped runtime db', async () => {
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'Docs',
      project: 'proj1',
      skillIds: '[]',
      model: 'normal',
      prompt: 'Run docs',
      schedule: null,
      enabled: true,
      docPaths: '[]',
      provider: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).execute();

    const { POST } = await import('@/app/api/agents/[agentId]/run/route');
    const { listQueuedAgentRunsForProject } = await import('@/lib/agents/queued-agent-runs');

    const req = new NextRequest('http://localhost/api/agents/agent-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Ship it' }),
    });

    const res = await POST(req, { params: Promise.resolve({ agentId: 'agent-1' }) });
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.code).toBe('pipeline_lock');

    await vi.waitFor(async () => {
      expect(await listQueuedAgentRunsForProject('proj1')).toEqual([
        expect.objectContaining({
          project: 'proj1',
          agentId: 'agent-1',
          agentName: 'Docs',
          prompt: 'Ship it',
        }),
      ]);
    });

    const tableRows = await sharedHandle.db.execute(sql.raw(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'queued_agent_runs'",
    ));
    const indexRows = await sharedHandle.db.execute(sql.raw(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'queued_agent_runs_project_agent'",
    ));
    expect(tableRows.rows.length).toBe(1);
    expect(indexRows.rows.length).toBe(1);
  });
});
