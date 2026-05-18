import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL
  // separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

async function flushDbQueue(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw('SELECT 1'));
}

describe('file-agent-overrides', () => {
  let sharedHandle: TestDbHandle;
  // Backward-compat shim so existing test bodies referencing `handle.db` still
  // hit the shared PGlite instance.
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };

  let getFileAgentOverride: typeof import('@/lib/agents/file-agent-overrides').getFileAgentOverride;
  let setFileAgentOverride: typeof import('@/lib/agents/file-agent-overrides').setFileAgentOverride;
  let deleteFileAgentOverride: typeof import('@/lib/agents/file-agent-overrides').deleteFileAgentOverride;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));

    const mod = await import('@/lib/agents/file-agent-overrides');
    getFileAgentOverride = mod.getFileAgentOverride;
    setFileAgentOverride = mod.setFileAgentOverride;
    deleteFileAgentOverride = mod.deleteFileAgentOverride;
  });

  afterAll(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('DELETE FROM settings'));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function insertSetting(key: string, value: string) {
    await handle.db.insert(schema.settings).values({ key, value });
  }

  describe('getFileAgentOverride', () => {
    it('returns null when no override exists', async () => {
      expect(await getFileAgentOverride('myproject', 'myagent')).toBeNull();
    });

    it('returns stored override', async () => {
      await insertSetting(
        'agent_override:myproject:myagent',
        JSON.stringify({ enabled: false, model: 'haiku' }),
      );
      const result = await getFileAgentOverride('myproject', 'myagent');
      expect(result).toEqual({ enabled: false, model: 'fast' });
    });

    it('sanitizes an invalid stored model override back to normal', async () => {
      await insertSetting(
        'agent_override:myproject:myagent',
        JSON.stringify({ enabled: true, model: 'smart --resume injected' }),
      );
      const result = await getFileAgentOverride('myproject', 'myagent');
      expect(result).toEqual({ enabled: true, model: 'normal' });
    });

    it('returns null for invalid JSON value', async () => {
      await insertSetting(
        'agent_override:myproject:myagent',
        'not-json{{{',
      );
      expect(await getFileAgentOverride('myproject', 'myagent')).toBeNull();
    });

    it('returns null when value is a JSON primitive (not an object)', async () => {
      await insertSetting(
        'agent_override:myproject:myagent',
        '"just-a-string"',
      );
      expect(await getFileAgentOverride('myproject', 'myagent')).toBeNull();
    });

    it('scopes by project and name — different names do not collide', async () => {
      await insertSetting(
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
      await setFileAgentOverride('proj', 'agent', { enabled: true });
      const result = await setFileAgentOverride('proj', 'agent', { model: 'haiku' });
      expect(result.enabled).toBe(true);
      expect(result.model).toBe('fast');
    });

    it('returns the merged value (not just the patch)', async () => {
      await setFileAgentOverride('proj', 'agent', { enabled: true });
      const result = await setFileAgentOverride('proj', 'agent', { schedule: '8h' });
      expect(result).toMatchObject({ enabled: true, schedule: '8h' });
    });
  });

  describe('deleteFileAgentOverride', () => {
    it('removes an existing override', async () => {
      await setFileAgentOverride('proj', 'agent', { enabled: false });
      expect(await getFileAgentOverride('proj', 'agent')).not.toBeNull();
      deleteFileAgentOverride('proj', 'agent');
      await flushDbQueue(sharedHandle);
      expect(await getFileAgentOverride('proj', 'agent')).toBeNull();
    });

    it('is a no-op when override does not exist', () => {
      expect(() => deleteFileAgentOverride('proj', 'ghost')).not.toThrow();
    });

    it('only deletes the targeted override, not others', async () => {
      await setFileAgentOverride('proj', 'a1', { enabled: false });
      await setFileAgentOverride('proj', 'a2', { enabled: true });
      deleteFileAgentOverride('proj', 'a1');
      await flushDbQueue(sharedHandle);
      expect(await getFileAgentOverride('proj', 'a1')).toBeNull();
      expect(await getFileAgentOverride('proj', 'a2')).toEqual({ enabled: true });
    });
  });
});
