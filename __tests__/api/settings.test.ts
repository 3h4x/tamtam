import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('settings API', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: any;
  let PATCH: any;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));

    vi.doMock('@/lib/auth', () => ({
      checkAuth: (request: NextRequest) => {
        const token = process.env.Z_API_TOKEN;
        if (!token) return null;
        const authHeader = request.headers.get('authorization') ?? '';
        if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== token) {
          const { NextResponse } = require('next/server');
          return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 });
        }
        return null;
      },
    }));

    const mod = await import('@/app/api/settings/route');
    GET = mod.GET;
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.Z_API_TOKEN;
  });

  describe('GET /settings', () => {
    it('returns empty settings object initially', async () => {
      const response = await GET();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.settings).toEqual({});
    });

    it('returns all stored settings', async () => {
      const db = testDb.db;
      db.insert(schema.settings).values({ key: 'workspace_path', value: '/projects' }).run();
      db.insert(schema.settings).values({ key: 'github_owner', value: 'octocat' }).run();

      const response = await GET();
      const data = await response.json();
      expect(data.settings.workspace_path).toBe('/projects');
      expect(data.settings.github_owner).toBe('octocat');
    });

    it('does not require authentication', async () => {
      process.env.Z_API_TOKEN = 'secret';
      const response = await GET();
      expect(response.status).toBe(200);
    });
  });

  describe('PATCH /settings', () => {
    it('requires authentication when Z_API_TOKEN is set', async () => {
      process.env.Z_API_TOKEN = 'secret';
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ workspace_path: '/new' }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(401);
    });

    it('updates a setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ workspace_path: '/home/user/projects' }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');

      const row = testDb.db
        .select()
        .from(schema.settings)
        .all()
        .find((r) => r.key === 'workspace_path');
      expect(row?.value).toBe('/home/user/projects');
    });

    it('updates multiple settings at once', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          workspace_path: '/projects',
          github_owner: 'octocat',
          frequency: '2h',
        }),
      });
      await PATCH(request);

      const rows = testDb.db.select().from(schema.settings).all();
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.workspace_path).toBe('/projects');
      expect(map.github_owner).toBe('octocat');
      expect(map.frequency).toBe('2h');
    });

    it('ignores unknown keys', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ unknown_key: 'value', workspace_path: '/valid' }),
      });
      await PATCH(request);

      const rows = testDb.db.select().from(schema.settings).all();
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.workspace_path).toBe('/valid');
      expect('unknown_key' in map).toBe(false);
    });

    it('deletes a setting when value is null', async () => {
      testDb.db.insert(schema.settings).values({ key: 'github_owner', value: 'old' }).run();

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ github_owner: null }),
      });
      await PATCH(request);

      const rows = testDb.db.select().from(schema.settings).all();
      const found = rows.find((r) => r.key === 'github_owner');
      expect(found).toBeUndefined();
    });

    it('deletes a setting when value is empty string', async () => {
      testDb.db.insert(schema.settings).values({ key: 'github_owner', value: 'old' }).run();

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ github_owner: '' }),
      });
      await PATCH(request);

      const rows = testDb.db.select().from(schema.settings).all();
      const found = rows.find((r) => r.key === 'github_owner');
      expect(found).toBeUndefined();
    });

    it('upserts an existing setting', async () => {
      testDb.db.insert(schema.settings).values({ key: 'claude_bin', value: '/old/claude' }).run();

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ claude_bin: '/new/claude' }),
      });
      await PATCH(request);

      const rows = testDb.db.select().from(schema.settings).all();
      const claudeRows = rows.filter((r) => r.key === 'claude_bin');
      expect(claudeRows).toHaveLength(1);
      expect(claudeRows[0].value).toBe('/new/claude');
    });

    it('saves and retrieves base_prompt', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ base_prompt: 'Be direct. No questions.' }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'base_prompt');
      expect(row?.value).toBe('Be direct. No questions.');
    });

    it('accepts all valid setting keys', async () => {
      const validKeys = [
        'github_owner',
        'claude_bin',
        'log_dir',
        'frequency',
        'daytime',
        'weekends',
        'launchagent_prefix',
        'workspace_path',
        'base_prompt',
      ];

      const body = Object.fromEntries(validKeys.map((k) => [k, 'test-value']));
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await PATCH(request);

      const rows = testDb.db.select().from(schema.settings).all();
      expect(rows).toHaveLength(validKeys.length);
    });
  });
});
