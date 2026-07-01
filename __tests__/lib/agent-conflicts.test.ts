import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      skill_ids text NOT NULL DEFAULT '[]',
      doc_paths text NOT NULL DEFAULT '[]',
      model text NOT NULL DEFAULT 'sonnet',
      prompt text NOT NULL DEFAULT '',
      schedule text,
      enabled boolean NOT NULL DEFAULT true,
      boostable boolean NOT NULL DEFAULT true,
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
      permission_mode text,
      kind text NOT NULL DEFAULT 'user',
      role text NOT NULL DEFAULT 'producer',
      autopilot_state text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
}

describe('findAgentNameConflict', () => {
  let sharedHandle: TestDbHandle;
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let findAgentNameConflict: (
    project: string,
    name: string,
    options?: {
      excludeDbAgentId?: string;
    },
  ) => Promise<import('@/lib/agents/agent-conflicts').AgentNameConflict | null>;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    // Let any straggling fire-and-forget queries settle before closing.
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents'));

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));

    const mod = await import('@/lib/agents/agent-conflicts');
    findAgentNameConflict = mod.findAgentNameConflict;
  });

  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function insertAgent(id: string, project: string, name: string) {
    const now = Date.now();
    await handle.db.insert(schema.agents).values({
      id,
      name,
      project,
      skillIds: '[]',
      docPaths: '[]',
      model: 'sonnet',
      prompt: '',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  it('returns null when no DB agent matches', async () => {
    expect(await findAgentNameConflict('myproject', 'my-agent')).toBeNull();
  });

  it('detects a DB agent name conflict (exact match)', async () => {
    await insertAgent('agent-1', 'myproject', 'my-agent');

    const conflict = await findAgentNameConflict('myproject', 'my-agent');
    expect(conflict).toEqual({ kind: 'db', name: 'my-agent', agentId: 'agent-1' });
  });

  it('detects a DB agent name conflict case-insensitively', async () => {
    await insertAgent('agent-2', 'myproject', 'My-Agent');

    const conflict = await findAgentNameConflict('myproject', 'my-agent');
    expect(conflict).not.toBeNull();
    expect(conflict?.kind).toBe('db');
    expect(conflict?.agentId).toBe('agent-2');
  });

  it('skips DB agent when excludeDbAgentId matches', async () => {
    await insertAgent('agent-1', 'myproject', 'my-agent');

    const conflict = await findAgentNameConflict('myproject', 'my-agent', { excludeDbAgentId: 'agent-1' });
    expect(conflict).toBeNull();
  });

  it('does not skip a different DB agent when excludeDbAgentId is set', async () => {
    await insertAgent('agent-1', 'myproject', 'my-agent');
    await insertAgent('agent-2', 'myproject', 'other-agent');

    const conflict = await findAgentNameConflict('myproject', 'my-agent', { excludeDbAgentId: 'agent-2' });
    expect(conflict?.agentId).toBe('agent-1');
  });

  it('only matches agents belonging to the same project', async () => {
    await insertAgent('agent-a', 'project-a', 'shared-name');

    const conflict = await findAgentNameConflict('project-b', 'shared-name');
    expect(conflict).toBeNull();
  });
});
