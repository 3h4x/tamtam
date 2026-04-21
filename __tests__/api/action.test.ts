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
      auto_commit_enabled INTEGER DEFAULT 0,
      auto_push_enabled INTEGER DEFAULT 0,
      release_after_run INTEGER DEFAULT 0,
      pr_pipeline INTEGER DEFAULT 0,
      auto_pr_merge_enabled INTEGER DEFAULT 0,
      issue_auto_branch INTEGER DEFAULT 1,
      last_push_error TEXT,
      last_push_at REAL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      pid INTEGER NOT NULL,
      log_path TEXT,
      started_at REAL NOT NULL,
      finished_at REAL,
      exit_code INTEGER,
      seen INTEGER DEFAULT 0
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('action API (GET and PUT)', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let GET: any;
  let PUT: any;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();

    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/action/route');
    GET = mod.GET;
    PUT = mod.PUT;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('GET /projects/by-project/[projectName]/action', () => {
    it('returns empty actions when project does not exist', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/unknown/action');
      const response = await GET(request, {
        params: Promise.resolve({ projectName: 'unknown' }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.actions).toEqual([]);
    });

    it('returns empty actions when project has no custom actions', async () => {
      testDb.db
        .insert(schema.projects)
        .values({ name: 'proj1', path: '/path/to/proj1', customActions: null })
        .run();

      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action');
      const response = await GET(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      const data = await response.json();
      expect(data.actions).toEqual([]);
    });

    it('returns project custom actions', async () => {
      const actions = [
        { name: 'deploy', command: 'npm run deploy', color: 'green' },
        { name: 'test', command: 'npm test' },
      ];
      testDb.db
        .insert(schema.projects)
        .values({
          name: 'proj1',
          path: '/path/to/proj1',
          customActions: JSON.stringify(actions),
        })
        .run();

      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action');
      const response = await GET(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      const data = await response.json();
      expect(data.actions).toHaveLength(2);
      expect(data.actions[0].name).toBe('deploy');
      expect(data.actions[0].command).toBe('npm run deploy');
      expect(data.actions[0].color).toBe('green');
    });

    it('returns empty actions when custom_actions is invalid JSON', async () => {
      testDb.db
        .insert(schema.projects)
        .values({
          name: 'proj1',
          path: '/path/to/proj1',
          customActions: 'not-valid-json',
        })
        .run();

      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action');
      const response = await GET(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      const data = await response.json();
      expect(data.actions).toEqual([]);
    });

  });

  describe('PUT /projects/by-project/[projectName]/action', () => {
    beforeEach(() => {
      testDb.db
        .insert(schema.projects)
        .values({ name: 'proj1', path: '/path/to/proj1' })
        .run();
    });

    it('validates that actions is an array', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: 'not-an-array' }),
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.detail).toContain('array');
    });

    it('validates each action has name and command', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: [{ name: 'deploy' }] }), // missing command
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.detail).toContain('command');
    });

    it('validates each action has a name', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: [{ command: 'npm run x' }] }), // missing name
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(400);
    });

    it('saves valid actions and returns them', async () => {
      const actions = [
        { name: 'deploy', command: 'npm run deploy', color: 'green' },
        { name: 'build', command: 'npm run build' },
      ];
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions }),
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.actions).toEqual(actions);
    });

    it('accepts empty actions array', async () => {
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions: [] }),
      });
      const response = await PUT(request, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.actions).toEqual([]);
    });

    it('persists actions to database', async () => {
      const actions = [{ name: 'deploy', command: 'npm run deploy' }];
      const request = new NextRequest('http://localhost/api/projects/by-project/proj1/action', {
        method: 'PUT',
        body: JSON.stringify({ actions }),
      });
      await PUT(request, { params: Promise.resolve({ projectName: 'proj1' }) });

      const getRequest = new NextRequest(
        'http://localhost/api/projects/by-project/proj1/action'
      );
      const getResponse = await GET(getRequest, {
        params: Promise.resolve({ projectName: 'proj1' }),
      });
      const data = await getResponse.json();
      expect(data.actions).toHaveLength(1);
      expect(data.actions[0].name).toBe('deploy');
    });
  });
});
