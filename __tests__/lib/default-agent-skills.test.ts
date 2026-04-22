import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('seedDefaultSkills', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let seedFn: typeof import('@/lib/default-agent-skills').seedDefaultSkills;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    const mod = await import('@/lib/default-agent-skills');
    seedFn = mod.seedDefaultSkills;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('inserts all default skills on first call', () => {
    seedFn();
    const skills = testDb.db.select().from(schema.skills).all();
    expect(skills.length).toBeGreaterThanOrEqual(9);
  });

  it('inserts agent-self-improve with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-self-improve');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:self-improve');
    expect(skill!.content).toContain('http://localhost:1337');
    expect(skill!.content).toContain('/api/agents/by-name');
    expect(skill!.description).toContain('TamTam');
  });

  it('inserts agent-cto with correct fields', () => {
    seedFn();
    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('agent:cto');
    expect(skill!.content).toContain('You are the CTO of this project');
    expect(skill!.description).toContain('GitHub issues');
  });

  it('does not insert skills on second call (seeded guard)', () => {
    seedFn();
    const countAfterFirst = testDb.db.select().from(schema.skills).all().length;

    // Manually insert an extra row to detect if seed runs again
    testDb.db.insert(schema.skills).values({
      id: 'canary',
      name: 'canary',
      description: '',
      content: 'x',
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
    }).run();

    seedFn(); // second call — should be a no-op, not duplicate-insert
    const allIds = testDb.db.select().from(schema.skills).all().map((s) => s.id);
    // All original ids still present, no duplicates possible since id is PRIMARY KEY
    // The real assertion: row count is exactly countAfterFirst + 1 (canary only)
    expect(allIds.length).toBe(countAfterFirst + 1);
  });

  it('skips inserting a skill that already exists with content', () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'custom-name',
      description: 'custom-desc',
      content: 'custom-content',
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.name).toBe('custom-name');
    expect(skill!.content).toBe('custom-content');
    expect(skill!.description).toBe('custom-desc');
  });

  it('updates content and description for a skill that exists with empty content', () => {
    const now = Date.now() / 1000;
    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: '',
      content: '',
      createdAt: now,
      updatedAt: now,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.content).toContain('You are the CTO of this project');
    expect(skill!.description).toContain('GitHub issues');
  });

  it('does not modify updatedAt for skills that already have content', () => {
    const oldTime = 1_000_000;
    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: 'old',
      content: 'existing content',
      createdAt: oldTime,
      updatedAt: oldTime,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.updatedAt).toBe(oldTime);
  });

  it('sets updatedAt to a recent timestamp when backfilling empty content', () => {
    const oldTime = 1_000_000;
    const before = Date.now() / 1000;
    testDb.db.insert(schema.skills).values({
      id: 'agent-cto',
      name: 'agent:cto',
      description: '',
      content: '',
      createdAt: oldTime,
      updatedAt: oldTime,
    }).run();

    seedFn();

    const skill = testDb.db.select().from(schema.skills).all().find((s) => s.id === 'agent-cto');
    expect(skill!.updatedAt).toBeGreaterThanOrEqual(before);
  });
});
