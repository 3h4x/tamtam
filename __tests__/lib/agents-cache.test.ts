import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      skill_ids TEXT NOT NULL DEFAULT '[]',
      doc_paths TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT 'sonnet',
      prompt TEXT NOT NULL DEFAULT '',
      schedule TEXT,
      runner TEXT NOT NULL DEFAULT 'pm2',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

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
    runner: 'pm2',
    enabled: true,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('normalizeAgent', () => {
  let normalizeAgent: typeof import('@/lib/agents/agents-cache').normalizeAgent;

  beforeEach(async () => {
    vi.resetModules();
    const testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    const mod = await import('@/lib/agents/agents-cache');
    normalizeAgent = mod.normalizeAgent;
  });

  afterEach(() => {
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
    expect(result.model).toBe('opus');
    expect(result.prompt).toBe('hello');
  });

  it('handles null/missing skillIds gracefully', () => {
    const row = makeAgentRow({ skillIds: '' });
    const result = normalizeAgent(row);
    expect(result.skillIds).toEqual([]);
  });
});

describe('getAllAgentsCached', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let getAllAgentsCached: typeof import('@/lib/agents/agents-cache').getAllAgentsCached;
  let clearAgentsCache: typeof import('@/lib/agents/agents-cache').clearAgentsCache;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    const mod = await import('@/lib/agents/agents-cache');
    getAllAgentsCached = mod.getAllAgentsCached;
    clearAgentsCache = mod.clearAgentsCache;
    clearAgentsCache();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns empty array when no agents exist', () => {
    const agents = getAllAgentsCached();
    expect(agents).toEqual([]);
  });

  it('returns agents from database', () => {
    testDb.db.insert(schema.agents).values(makeAgentRow()).run();
    const agents = getAllAgentsCached();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('agent-1');
  });

  it('returns multiple agents', () => {
    testDb.db.insert(schema.agents).values(makeAgentRow({ id: 'a1', name: 'agent-one' })).run();
    testDb.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'agent-two' })).run();
    const agents = getAllAgentsCached();
    expect(agents).toHaveLength(2);
  });

  it('returns cached results on second call (no DB re-query for same data)', () => {
    testDb.db.insert(schema.agents).values(makeAgentRow()).run();
    const first = getAllAgentsCached();
    // Add a second agent directly without clearing cache
    testDb.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'agent-two' })).run();
    const second = getAllAgentsCached();
    // Should still return 1 agent from cache
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second).toBe(first); // Same reference from cache
  });

  it('returns fresh results after clearAgentsCache', () => {
    testDb.db.insert(schema.agents).values(makeAgentRow()).run();
    const first = getAllAgentsCached();
    expect(first).toHaveLength(1);
    // Add second agent and clear cache
    testDb.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'agent-two' })).run();
    clearAgentsCache();
    const second = getAllAgentsCached();
    expect(second).toHaveLength(2);
  });

  it('re-fetches after TTL expires', async () => {
    vi.useFakeTimers();
    testDb.db.insert(schema.agents).values(makeAgentRow()).run();
    const first = getAllAgentsCached();
    expect(first).toHaveLength(1);

    // Add second agent and advance time past TTL (10 seconds)
    testDb.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'agent-two' })).run();
    vi.advanceTimersByTime(11_000);

    const second = getAllAgentsCached();
    expect(second).toHaveLength(2);
    vi.useRealTimers();
  });
});

describe('clearAgentsCache', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let getAllAgentsCached: typeof import('@/lib/agents/agents-cache').getAllAgentsCached;
  let clearAgentsCache: typeof import('@/lib/agents/agents-cache').clearAgentsCache;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    const mod = await import('@/lib/agents/agents-cache');
    getAllAgentsCached = mod.getAllAgentsCached;
    clearAgentsCache = mod.clearAgentsCache;
    clearAgentsCache();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('calling clearAgentsCache on empty cache does not throw', () => {
    expect(() => clearAgentsCache()).not.toThrow();
  });

  it('forces a fresh DB read on next getAllAgentsCached call', () => {
    testDb.db.insert(schema.agents).values(makeAgentRow({ id: 'a1', name: 'first' })).run();
    getAllAgentsCached(); // populate cache

    clearAgentsCache();

    testDb.db.insert(schema.agents).values(makeAgentRow({ id: 'a2', name: 'second' })).run();
    const agents = getAllAgentsCached();
    expect(agents).toHaveLength(2);
  });
});
