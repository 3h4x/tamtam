import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

let sharedHandle: TestDbHandle;

async function applyDdl(h: TestDbHandle): Promise<void> {
  await h.db.execute(sql.raw(`
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
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
}

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

function makeAgentRow(overrides: Partial<typeof schema.agents.$inferSelect> = {}) {
  return {
    id: 'agent-1',
    name: 'test-agent',
    project: 'my-project',
    skillIds: '[]',
    docPaths: '[]',
    model: 'sonnet',
    prompt: 'do things',
    schedule: null,
    enabled: true,
    provider: null,
    fallbackEnabled: false,
    prerequisiteCommand: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('normalizeAgent', () => {
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let normalizeAgent: typeof import('@/lib/agents/agents-cache').normalizeAgent;

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/agents/agents-cache');
    normalizeAgent = mod.normalizeAgent;
  });

  afterEach(async () => {
    vi.resetModules();
  });

  it('parses empty skillIds JSON array', () => {
    const row = makeAgentRow({ skillIds: '[]' });
    const result = normalizeAgent(row);
    expect(result.skillIds).toEqual([]);
  });

  it('parses skillIds with values', () => {
    const row = makeAgentRow({ skillIds: '["skill-1","skill-2"]' });
    const result = normalizeAgent(row);
    expect(result.skillIds).toEqual(['skill-1', 'skill-2']);
  });

  it('preserves all other agent fields', () => {
    const row = makeAgentRow({ name: 'my-agent', project: 'proj', model: 'opus', prompt: 'hello' });
    const result = normalizeAgent(row);
    expect(result.name).toBe('my-agent');
    expect(result.project).toBe('proj');
    expect(result.model).toBe('smart');
    expect(result.prompt).toBe('hello');
  });

  it('falls back to normal when a stored agent model is invalid', () => {
    const row = makeAgentRow({ model: 'smart --resume injected' });
    const result = normalizeAgent(row);
    expect(result.model).toBe('normal');
  });

  it('handles null/missing skillIds gracefully', () => {
    const row = makeAgentRow({ skillIds: '' });
    const result = normalizeAgent(row);
    expect(result.skillIds).toEqual([]);
  });

  it('keeps an explicitly cleared issue-cruncher prerequisite blank', () => {
    const row = makeAgentRow({
      skillIds: '["agent-issue-cruncher"]',
      prerequisiteCommand: '',
    });
    const result = normalizeAgent(row);
    expect(result.prerequisiteCommand).toBeNull();
  });
  // reference handle so it is not flagged as unused
  void handle;
});

describe('getAllAgentsCachedAsync', () => {
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let getAllAgentsCachedAsync: typeof import('@/lib/agents/agents-cache').getAllAgentsCachedAsync;
  let clearAgentsCache: typeof import('@/lib/agents/agents-cache').clearAgentsCache;

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/agents/agents-cache');
    getAllAgentsCachedAsync = mod.getAllAgentsCachedAsync;
    clearAgentsCache = mod.clearAgentsCache;
    clearAgentsCache();
  });

  afterEach(async () => {
    vi.resetModules();
  });

  it('returns empty array when no agents exist', async () => {
    const agents = await getAllAgentsCachedAsync();
    expect(agents).toEqual([]);
  });

  it('returns agents from database', async () => {
    await handle.db.insert(schema.agents).values(makeAgentRow());
    const agents = await getAllAgentsCachedAsync();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('agent-1');
  });

  it('returns multiple agents', async () => {
    await handle.db.insert(schema.agents).values(makeAgentRow({ id: 'a1', name: 'agent-one' }));
    await handle.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'agent-two' }));
    const agents = await getAllAgentsCachedAsync();
    expect(agents).toHaveLength(2);
  });

  it('returns cached results on second call (no DB re-query for same data)', async () => {
    await handle.db.insert(schema.agents).values(makeAgentRow());
    const first = await getAllAgentsCachedAsync();
    // Add a second agent directly without clearing cache
    await handle.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'agent-two' }));
    const second = await getAllAgentsCachedAsync();
    // Should still return 1 agent from cache
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second).toBe(first); // Same reference from cache
  });

  it('returns fresh results after clearAgentsCache', async () => {
    await handle.db.insert(schema.agents).values(makeAgentRow());
    const first = await getAllAgentsCachedAsync();
    expect(first).toHaveLength(1);
    // Add second agent and clear cache
    await handle.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'agent-two' }));
    clearAgentsCache();
    const second = await getAllAgentsCachedAsync();
    expect(second).toHaveLength(2);
  });

  it('re-fetches after TTL expires', async () => {
    vi.useFakeTimers();
    try {
      await handle.db.insert(schema.agents).values(makeAgentRow());
      const first = await getAllAgentsCachedAsync();
      expect(first).toHaveLength(1);

      // Add second agent and advance time past TTL (10 seconds)
      await handle.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'agent-two' }));
      vi.advanceTimersByTime(11_000);

      const second = await getAllAgentsCachedAsync();
      expect(second).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clearAgentsCache', () => {
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let getAllAgentsCachedAsync: typeof import('@/lib/agents/agents-cache').getAllAgentsCachedAsync;
  let clearAgentsCache: typeof import('@/lib/agents/agents-cache').clearAgentsCache;

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents'));
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/agents/agents-cache');
    getAllAgentsCachedAsync = mod.getAllAgentsCachedAsync;
    clearAgentsCache = mod.clearAgentsCache;
    clearAgentsCache();
  });

  afterEach(async () => {
    vi.resetModules();
  });

  it('calling clearAgentsCache on empty cache does not throw', () => {
    expect(() => clearAgentsCache()).not.toThrow();
  });

  it('forces a fresh DB read on next getAllAgentsCachedAsync call', async () => {
    await handle.db.insert(schema.agents).values(makeAgentRow({ id: 'a1', name: 'first' }));
    await getAllAgentsCachedAsync(); // populate cache

    clearAgentsCache();

    await handle.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'second' }));
    const agents = await getAllAgentsCachedAsync();
    expect(agents).toHaveLength(2);
  });
});
