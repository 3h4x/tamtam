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

    const mod = await import('@/app/api/settings/route');
    GET = mod.GET;
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
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

  });

  describe('PATCH /settings', () => {
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
        'default_model',
        'permission_mode',
        'commit_style',
        'review_verdict_rules',
        'fix_ci_max_retries',
        'fix_ci_retry_window_seconds',
        'fix_ci_fast_crash_ms',
        'agent_templates',
        'notification_webhook_url',
        'notification_webhook_secret',
        'notification_on_release_success',
        'notification_on_release_fail',
        'notification_on_fix_loop_exhausted',
        'notification_on_review_do_not_ship',
        'notification_on_agent_run_fail',
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

    it('saves commit_style setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ commit_style: 'squash everything into one commit' }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'commit_style');
      expect(row?.value).toBe('squash everything into one commit');
    });

    it('saves fix_ci_max_retries setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ fix_ci_max_retries: '5' }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'fix_ci_max_retries');
      expect(row?.value).toBe('5');
    });

    it('saves review_verdict_rules setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_verdict_rules: 'Always LGTM unless broken' }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'review_verdict_rules');
      expect(row?.value).toBe('Always LGTM unless broken');
    });

    it('saves agent_templates as a JSON string', async () => {
      const templates = [
        { name: 'security-review', description: 'Scans for OWASP issues', model: 'sonnet', schedule: '24h', runner: 'pm2', prompt: 'Review the diff for security issues.' },
      ];
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ agent_templates: JSON.stringify(templates) }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'agent_templates');
      expect(row?.value).toBe(JSON.stringify(templates));
      expect(JSON.parse(row!.value)).toEqual(templates);
    });

    it('deletes agent_templates when set to empty string', async () => {
      testDb.db.insert(schema.settings).values({ key: 'agent_templates', value: '[{"name":"old"}]' }).run();

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ agent_templates: '' }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'agent_templates');
      expect(row).toBeUndefined();
    });
  });

  describe('reloadConfig on PATCH', () => {
    let reloadConfigMock: ReturnType<typeof vi.fn>;
    let PATCHWithSpy: any;

    beforeEach(async () => {
      vi.resetModules();
      testDb.sqlite.close();
      testDb = createTestDb();

      reloadConfigMock = vi.fn();
      vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
      vi.doMock('@/lib/config', () => ({ reloadConfig: reloadConfigMock }));

      const mod = await import('@/app/api/settings/route');
      PATCHWithSpy = mod.PATCH;
    });

    afterEach(() => {
      testDb.sqlite.close();
    });

    it('calls reloadConfig after saving settings', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ workspace_path: '/new/path' }),
      });
      await PATCHWithSpy(request);

      expect(reloadConfigMock).toHaveBeenCalledOnce();
    });
  });
});
