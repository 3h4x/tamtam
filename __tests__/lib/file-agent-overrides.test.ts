import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('file-agent-overrides', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let getFileAgentOverride: typeof import('@/lib/agents/file-agent-overrides').getFileAgentOverride;
  let setFileAgentOverride: typeof import('@/lib/agents/file-agent-overrides').setFileAgentOverride;
  let deleteFileAgentOverride: typeof import('@/lib/agents/file-agent-overrides').deleteFileAgentOverride;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));

    const mod = await import('@/lib/agents/file-agent-overrides');
    getFileAgentOverride = mod.getFileAgentOverride;
    setFileAgentOverride = mod.setFileAgentOverride;
    deleteFileAgentOverride = mod.deleteFileAgentOverride;
  });

  afterEach(() => {
    testDb.sqlite.close();
    vi.resetModules();
  });

  describe('getFileAgentOverride', () => {
    it('returns null when no override exists', async () => {
      expect(await getFileAgentOverride('myproject', 'myagent')).toBeNull();
    });

    it('returns stored override', async () => {
      testDb.sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
        'agent_override:myproject:myagent',
        JSON.stringify({ enabled: false, model: 'haiku' }),
      );
      const result = await getFileAgentOverride('myproject', 'myagent');
      expect(result).toEqual({ enabled: false, model: 'fast' });
    });

    it('sanitizes an invalid stored model override back to normal', async () => {
      testDb.sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
        'agent_override:myproject:myagent',
        JSON.stringify({ enabled: true, model: 'smart --resume injected' }),
      );
      const result = await getFileAgentOverride('myproject', 'myagent');
      expect(result).toEqual({ enabled: true, model: 'normal' });
    });

    it('returns null for invalid JSON value', async () => {
      testDb.sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
        'agent_override:myproject:myagent',
        'not-json{{{',
      );
      expect(await getFileAgentOverride('myproject', 'myagent')).toBeNull();
    });

    it('returns null when value is a JSON primitive (not an object)', async () => {
      testDb.sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
        'agent_override:myproject:myagent',
        '"just-a-string"',
      );
      expect(await getFileAgentOverride('myproject', 'myagent')).toBeNull();
    });

    it('scopes by project and name — different names do not collide', async () => {
      testDb.sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
        'agent_override:p1:a1',
        JSON.stringify({ enabled: true }),
      );
      expect(await getFileAgentOverride('p1', 'a2')).toBeNull();
      expect(await getFileAgentOverride('p2', 'a1')).toBeNull();
    });
  });

  describe('setFileAgentOverride', () => {
    it('creates a new override from scratch', async () => {
      const result = await setFileAgentOverride('proj', 'agent', { enabled: false });
      expect(result).toEqual({ enabled: false });
      expect(await getFileAgentOverride('proj', 'agent')).toEqual({ enabled: false });
    });

    it('merges patch with existing override (non-destructive)', async () => {
      await setFileAgentOverride('proj', 'agent', { enabled: true, model: 'sonnet' });
      const result = await setFileAgentOverride('proj', 'agent', { schedule: '4h' });
      expect(result).toEqual({ enabled: true, model: 'normal', schedule: '4h' });
    });

    it('overwrites individual fields on re-patch', async () => {
      await setFileAgentOverride('proj', 'agent', { enabled: true, model: 'sonnet' });
      const result = await setFileAgentOverride('proj', 'agent', { model: 'opus' });
      expect(result.model).toBe('smart');
      expect(result.enabled).toBe(true);
    });

    it('sets schedule to null explicitly', async () => {
      await setFileAgentOverride('proj', 'agent', { schedule: '4h' });
      const result = await setFileAgentOverride('proj', 'agent', { schedule: null });
      expect(result.schedule).toBeNull();
    });

    it('stores skillIds array', async () => {
      const result = await setFileAgentOverride('proj', 'agent', { skillIds: ['tests', 'review'] });
      expect(result.skillIds).toEqual(['tests', 'review']);
    });

    it('does not overwrite a field not included in the patch', async () => {
      await setFileAgentOverride('proj', 'agent', { runner: 'pm2', enabled: true });
      const result = await setFileAgentOverride('proj', 'agent', { model: 'haiku' });
      expect(result.runner).toBe('pm2');
      expect(result.enabled).toBe(true);
      expect(result.model).toBe('fast');
    });

    it('returns the merged value (not just the patch)', async () => {
      await setFileAgentOverride('proj', 'agent', { enabled: true });
      const result = await setFileAgentOverride('proj', 'agent', { runner: 'pm2' });
      expect(result).toMatchObject({ enabled: true, runner: 'pm2' });
    });
  });

  describe('deleteFileAgentOverride', () => {
    it('removes an existing override', async () => {
      await setFileAgentOverride('proj', 'agent', { enabled: false });
      expect(await getFileAgentOverride('proj', 'agent')).not.toBeNull();
      deleteFileAgentOverride('proj', 'agent');
      expect(await getFileAgentOverride('proj', 'agent')).toBeNull();
    });

    it('is a no-op when override does not exist', () => {
      expect(() => deleteFileAgentOverride('proj', 'ghost')).not.toThrow();
    });

    it('only deletes the targeted override, not others', async () => {
      await setFileAgentOverride('proj', 'a1', { enabled: false });
      await setFileAgentOverride('proj', 'a2', { enabled: true });
      deleteFileAgentOverride('proj', 'a1');
      expect(await getFileAgentOverride('proj', 'a1')).toBeNull();
      expect(await getFileAgentOverride('proj', 'a2')).toEqual({ enabled: true });
    });
  });
});
