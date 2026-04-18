import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      github TEXT,
      priority TEXT,
      custom_actions TEXT,
      test_command TEXT,
      test_cron_enabled INTEGER DEFAULT 0,
      test_cron_schedule TEXT,
      auto_push_enabled INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('resolveProjectPath', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let resolveProjectPath: typeof import('@/lib/project-data').resolveProjectPath;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    const mod = await import('@/lib/project-data');
    resolveProjectPath = mod.resolveProjectPath;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns null when no projects exist', () => {
    const result = resolveProjectPath('myproject');
    expect(result).toBeNull();
  });

  it('returns null when project is disabled', () => {
    testDb.db
      .insert(schema.projects)
      .values({ name: 'myproject', path: '/workspace/myproject', enabled: false })
      .run();

    const result = resolveProjectPath('myproject');
    expect(result).toBeNull();
  });

  it('returns path for enabled project', () => {
    testDb.db
      .insert(schema.projects)
      .values({ name: 'myproject', path: '/workspace/myproject', enabled: true })
      .run();

    const result = resolveProjectPath('myproject');
    expect(result).toBe('/workspace/myproject');
  });

  it('returns null when project name does not match any enabled project', () => {
    testDb.db
      .insert(schema.projects)
      .values({ name: 'other-project', path: '/workspace/other', enabled: true })
      .run();

    const result = resolveProjectPath('myproject');
    expect(result).toBeNull();
  });

  it('returns correct path when multiple enabled projects exist', () => {
    testDb.db.insert(schema.projects).values([
      { name: 'proj-a', path: '/workspace/proj-a', enabled: true },
      { name: 'proj-b', path: '/workspace/proj-b', enabled: true },
      { name: 'proj-c', path: '/workspace/proj-c', enabled: true },
    ]).run();

    expect(resolveProjectPath('proj-a')).toBe('/workspace/proj-a');
    expect(resolveProjectPath('proj-b')).toBe('/workspace/proj-b');
    expect(resolveProjectPath('proj-c')).toBe('/workspace/proj-c');
    expect(resolveProjectPath('proj-d')).toBeNull();
  });

  it('ignores disabled projects among enabled ones', () => {
    testDb.db.insert(schema.projects).values([
      { name: 'enabled-proj', path: '/workspace/enabled', enabled: true },
      { name: 'disabled-proj', path: '/workspace/disabled', enabled: false },
    ]).run();

    expect(resolveProjectPath('enabled-proj')).toBe('/workspace/enabled');
    expect(resolveProjectPath('disabled-proj')).toBeNull();
  });
});

describe('clearProjectDataCache', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let clearProjectDataCache: typeof import('@/lib/project-data').clearProjectDataCache;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    const mod = await import('@/lib/project-data');
    clearProjectDataCache = mod.clearProjectDataCache;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('can be called without error', () => {
    expect(() => clearProjectDataCache()).not.toThrow();
  });

  it('can be called multiple times without error', () => {
    clearProjectDataCache();
    clearProjectDataCache();
    clearProjectDataCache();
  });
});
