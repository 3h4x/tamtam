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
  let syncJobsPauseStateMock: ReturnType<typeof vi.fn>;
  let ensureProjectBoardMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    testDb = createTestDb();
    syncJobsPauseStateMock = vi.fn();
    ensureProjectBoardMock = vi.fn().mockResolvedValue({
      owner: 'octocat',
      title: 'TamTam',
      projectNumber: '7',
      projectUrl: 'https://github.com/users/octocat/projects/7',
      projectId: 'PVT_x',
      statusFieldId: 'F_x',
      optionIds: { 'Todo': '1', 'In Progress': '2', 'Review': '3', 'Fixing': '4', 'Blocked': '5', 'Done': '6' },
      customFieldIds: { project: 'F_P', agent: 'F_A', kind: 'F_K', branch: 'F_B' },
    });

    vi.doMock('@/lib/db', () => ({
      db: testDb.db,
      schema,
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      syncJobsPauseState: syncJobsPauseStateMock,
    }));
    vi.doMock('@/lib/github/project-board', () => ({
      ensureProjectBoard: ensureProjectBoardMock,
    }));

    const mod = await import('@/app/api/settings/route');
    GET = mod.GET;
    PATCH = mod.PATCH;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('GET /settings', () => {
    it('returns effective CLI routing defaults initially', async () => {
      const response = await GET();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.settings).toEqual({
        claude_provider: 'claude',
        cli_enabled_providers: 'claude',
        review_fix_max_iterations: '3',
        release_wall_clock_timeout_minutes: '60',
      });
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

    it('canonicalizes trusted_github_users in the API response', async () => {
      testDb.db
        .insert(schema.settings)
        .values({ key: 'trusted_github_users', value: JSON.stringify(['octocat', ' hubot ', 'OctoCat']) })
        .run();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.trusted_github_users).toBe('octocat, hubot');
    });

    it('canonicalizes budget subscription providers in the API response', async () => {
      testDb.db
        .insert(schema.settings)
        .values({ key: 'budget_subscription_providers', value: 'codex,gemini,codex' })
        .run();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.budget_subscription_providers).toBe('codex');
    });

    it('sanitizes invalid stored model settings in the API response', async () => {
      testDb.db.insert(schema.settings).values({ key: 'default_model', value: 'smart --resume injected' }).run();
      testDb.db.insert(schema.settings).values({ key: 'pipeline_model_review', value: 'normal --danger' }).run();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.default_model).toBe('fast');
      expect(data.settings.pipeline_model_review).toBe('');
    });

    it('normalizes invalid stored permission_mode in the API response', async () => {
      testDb.db.insert(schema.settings).values({ key: 'permission_mode', value: 'dangerousMode' }).run();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.permission_mode).toBe('acceptEdits');
    });

    it('returns the effective review_fix_max_iterations when the stored row is invalid', async () => {
      testDb.db.insert(schema.settings).values({ key: 'review_fix_max_iterations', value: 'abc' }).run();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.review_fix_max_iterations).toBe('3');
    });

    it('returns the effective review_fix_max_iterations when the stored row is zero', async () => {
      testDb.db.insert(schema.settings).values({ key: 'review_fix_max_iterations', value: '0' }).run();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.review_fix_max_iterations).toBe('3');
    });

    it('returns the effective review_fix_max_iterations when the stored row is negative', async () => {
      testDb.db.insert(schema.settings).values({ key: 'review_fix_max_iterations', value: '-1' }).run();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.review_fix_max_iterations).toBe('3');
    });

    it('canonicalizes CLI provider and per-provider model settings in the API response', async () => {
      testDb.db.insert(schema.settings).values({ key: 'cli_enabled_providers', value: 'codex gemini codex' }).run();
      testDb.db.insert(schema.settings).values({ key: 'cli_default_model_codex', value: 'sonnet' }).run();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.cli_enabled_providers).toBe('codex,gemini');
      expect(data.settings.cli_default_model_codex).toBe('normal');
    });

    it('hydrates effective CLI routing fields from legacy-only settings', async () => {
      testDb.db.insert(schema.settings).values({ key: 'claude_provider', value: 'codex' }).run();
      testDb.db.insert(schema.settings).values({ key: 'claude_bin', value: '/custom/claude' }).run();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.claude_provider).toBe('codex');
      expect(data.settings.cli_enabled_providers).toBe('codex');
      expect(data.settings.cli_bin_claude).toBe('/custom/claude');
      expect(data.settings.claude_bin).toBe('/custom/claude');
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

    it('rejects invalid permission_mode values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ permission_mode: 'dangerousMode' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.detail).toContain('permission_mode must be one of');
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

    it('rejects invalid default_model values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ default_model: 'smart --resume injected' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
      expect(testDb.db.select().from(schema.settings).all()).toEqual([]);
    });

    it('rejects invalid pipeline model overrides', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ pipeline_model_review: 'normal --danger' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
      expect(testDb.db.select().from(schema.settings).all()).toEqual([]);
    });

    it('saves jobs_paused and applies scheduler pause immediately', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ jobs_paused: 'true' }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'jobs_paused');
      expect(row?.value).toBe('true');
      expect(syncJobsPauseStateMock).toHaveBeenCalledWith(true);
    });

    it('accepts all valid setting keys', async () => {
      const validKeys = [
        'github_owner',
        'github_board_sync_enabled',
        'github_board_project_owner',
        'github_board_project_title',
        'github_board_project_number',
        'github_board_project_id',
        'github_board_status_field_id',
        'github_board_status_option_ids',
        'claude_provider',
        'claude_bin',
        'lmstudio_model',
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
        'jobs_paused',
        'review_fix_max_iterations',
        'release_wall_clock_timeout_minutes',
        'agent_templates',
        'notification_webhook_url',
        'notification_webhook_secret',
        'notification_on_release_success',
        'notification_on_release_fail',
        'notification_on_fix_loop_exhausted',
        'notification_on_review_do_not_ship',
        'notification_on_agent_run_fail',
        'budget_subscription_providers',
      ];

      const body = Object.fromEntries(validKeys.map((k) => [
        k,
        k === 'default_model' ? 'fast'
          : k === 'permission_mode' ? 'acceptEdits'
          : k.startsWith('pipeline_model_') ? 'normal'
          : k === 'review_fix_max_iterations' ? '5'
          : k === 'release_wall_clock_timeout_minutes' ? '30'
          : k === 'agent_templates'
            ? JSON.stringify([{ name: 'template', description: 'desc', model: 'smart', schedule: '', runner: 'pm2', prompt: '' }])
            : 'test-value',
      ]));
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

    it('saves budget subscription providers as a comma list', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ budget_subscription_providers: 'claude,codex' }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'budget_subscription_providers');
      expect(row?.value).toBe('claude,codex');
    });

    it('canonicalizes trusted_github_users before persisting them', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ trusted_github_users: 'octocat, hubot ' }),
      });
      const response = await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'trusted_github_users');
      expect(row?.value).toBe(JSON.stringify(['octocat', 'hubot']));
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          trusted_github_users: 'octocat, hubot',
        }),
      });
    });

    it('rejects duplicate trusted_github_users before persisting them', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ trusted_github_users: 'octocat, OctoCat' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: 'Duplicate GitHub login: OctoCat',
      });
      expect(testDb.db.select().from(schema.settings).all()).toEqual([]);
    });

    it('rejects trusted_github_users entries with empty rows', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ trusted_github_users: 'octocat,\n, hubot' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: 'Trusted GitHub users cannot be empty.',
      });
      expect(testDb.db.select().from(schema.settings).all()).toEqual([]);
    });

    it('canonicalizes budget subscription providers before persisting them', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ budget_subscription_providers: 'codex,gemini,codex' }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'budget_subscription_providers');
      expect(row?.value).toBe('codex');
    });

    it('saves CLI provider and per-provider model settings in canonical form', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          cli_enabled_providers: 'codex gemini codex',
          cli_default_model_codex: 'sonnet',
        }),
      });
      await PATCH(request);

      const rows = testDb.db.select().from(schema.settings).all();
      expect(rows.find((r) => r.key === 'cli_enabled_providers')?.value).toBe('codex,gemini');
      expect(rows.find((r) => r.key === 'cli_default_model_codex')?.value).toBe('normal');
      expect(rows.find((r) => r.key === 'claude_provider')?.value).toBe('codex');
    });

    it('syncs claude_provider to cli_enabled_providers even when the request sends a stale legacy value', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          claude_provider: 'claude',
          cli_enabled_providers: 'codex',
        }),
      });
      await PATCH(request);

      const rows = testDb.db.select().from(schema.settings).all();
      expect(rows.find((r) => r.key === 'cli_enabled_providers')?.value).toBe('codex');
      expect(rows.find((r) => r.key === 'claude_provider')?.value).toBe('codex');
    });

    it('preserves effective CLI routing when round-tripping legacy settings through an unrelated save', async () => {
      testDb.db.insert(schema.settings).values({ key: 'claude_provider', value: 'codex' }).run();
      testDb.db.insert(schema.settings).values({ key: 'claude_bin', value: '/custom/claude' }).run();

      const getResponse = await GET();
      const loaded = await getResponse.json();

      const patchRequest = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          ...loaded.settings,
          github_owner: 'octocat',
        }),
      });
      await PATCH(patchRequest);

      const rows = Object.fromEntries(testDb.db.select().from(schema.settings).all().map((row) => [row.key, row.value]));
      expect(rows.github_owner).toBe('octocat');
      expect(rows.claude_provider).toBe('codex');
      expect(rows.cli_enabled_providers).toBe('codex');
      expect(rows.claude_bin).toBe('/custom/claude');
      expect(rows.cli_bin_claude).toBe('/custom/claude');
    });

    it('does not rewrite a legacy custom provider to claude on an unrelated save round-trip', async () => {
      testDb.db.insert(schema.settings).values({ key: 'claude_provider', value: 'custom' }).run();
      testDb.db.insert(schema.settings).values({ key: 'claude_bin', value: '/usr/local/bin/acme-cli' }).run();

      const getResponse = await GET();
      const loaded = await getResponse.json();

      const patchRequest = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          ...loaded.settings,
          github_owner: 'octocat',
        }),
      });
      await PATCH(patchRequest);

      const rows = Object.fromEntries(testDb.db.select().from(schema.settings).all().map((row) => [row.key, row.value]));
      expect(rows.github_owner).toBe('octocat');
      expect(rows.claude_provider).toBe('custom');
      expect(rows.cli_enabled_providers).toBe('claude');
      expect(rows.claude_bin).toBe('/usr/local/bin/acme-cli');
      expect(rows.cli_bin_claude).toBe('/usr/local/bin/acme-cli');
    });

    it('saves review_fix_max_iterations setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_fix_max_iterations: '5' }),
      });
      const response = await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'review_fix_max_iterations');
      expect(row?.value).toBe('5');
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          review_fix_max_iterations: '5',
        }),
      });
    });

    it('returns canonicalized review_fix_max_iterations in PATCH responses', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_fix_max_iterations: '03' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          review_fix_max_iterations: '3',
        }),
      });

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'review_fix_max_iterations');
      expect(row?.value).toBe('3');
    });

    it('accepts zero-valued backup retention settings and returns them canonically', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          backup_retention_count: '0',
          backup_retention_weekly_count: '00',
        }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          backup_retention_count: '0',
          backup_retention_weekly_count: '0',
        }),
      });

      const rows = Object.fromEntries(testDb.db.select().from(schema.settings).all().map((row) => [row.key, row.value]));
      expect(rows.backup_retention_count).toBe('0');
      expect(rows.backup_retention_weekly_count).toBe('0');
    });

    it('rejects negative backup retention settings', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ backup_retention_count: '-1' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('backup_retention_count must be a non-negative integer'),
      });
      expect(testDb.db.select().from(schema.settings).all()).toEqual([]);
    });

    it('rejects non-numeric review_fix_max_iterations values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_fix_max_iterations: 'abc' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('review_fix_max_iterations must be a positive integer'),
      });
      expect(testDb.db.select().from(schema.settings).all()).toEqual([]);
    });

    it('rejects non-positive review_fix_max_iterations values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_fix_max_iterations: '0' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('review_fix_max_iterations must be a positive integer'),
      });
      expect(testDb.db.select().from(schema.settings).all()).toEqual([]);
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
      const canonicalTemplates = [
        { ...templates[0], model: 'normal' },
      ];
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ agent_templates: JSON.stringify(templates) }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'agent_templates');
      expect(row?.value).toBe(JSON.stringify(canonicalTemplates));
      expect(JSON.parse(row!.value)).toEqual(canonicalTemplates);
    });

    it('rejects agent_templates with invalid model values', async () => {
      const templates = [
        { name: 'security-review', description: 'Scans for OWASP issues', model: 'smart --resume injected', schedule: '24h', runner: 'pm2', prompt: 'Review the diff for security issues.' },
      ];
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ agent_templates: JSON.stringify(templates) }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
      expect(testDb.db.select().from(schema.settings).all()).toEqual([]);
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

    it('configures GitHub board settings when sync is enabled', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          github_owner: 'octocat',
          github_board_sync_enabled: 'true',
          github_board_project_owner: 'octocat',
          github_board_project_title: 'TamTam',
        }),
      });

      const response = await PATCH(request);

      expect(response.status).toBe(200);
      expect(ensureProjectBoardMock).toHaveBeenCalledWith({
        enabled: true,
        owner: 'octocat',
        title: 'TamTam',
      });
      const rows = Object.fromEntries(testDb.db.select().from(schema.settings).all().map((row) => [row.key, row.value]));
      expect(rows.github_board_project_number).toBe('7');
      expect(rows.github_board_project_id).toBe('PVT_x');
      expect(rows.github_board_status_field_id).toBe('F_x');
      expect(rows.github_board_status_option_ids).toContain('"In Progress":"2"');
    });

    it('persists github_board_status_option_ids as JSON when given an object', async () => {
      const optionIds = { 'Todo': 'Q', 'In Progress': 'R', 'Review': 'REV', 'Fixing': 'F', 'Blocked': 'B', 'Done': 'D' };
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ github_board_status_option_ids: optionIds }),
      });
      await PATCH(request);

      const row = testDb.db.select().from(schema.settings).all().find(r => r.key === 'github_board_status_option_ids');
      expect(row?.value).toBe(JSON.stringify(optionIds));
      expect(JSON.parse(row!.value)).toEqual(optionIds);
    });

    it('round-trips github_board_status_option_ids through GET', async () => {
      const optionIds = { 'Todo': 'Q', 'In Progress': 'R' };
      testDb.db.insert(schema.settings).values({ key: 'github_board_status_option_ids', value: JSON.stringify(optionIds) }).run();
      const response = await GET();
      const data = await response.json();
      expect(JSON.parse(data.settings.github_board_status_option_ids)).toEqual(optionIds);
    });

    it('round-trips github_board_custom_field_ids through GET', async () => {
      const customFieldIds = { project: 'P', agent: 'A', kind: 'K', branch: 'B' };
      testDb.db.insert(schema.settings).values({ key: 'github_board_custom_field_ids', value: JSON.stringify(customFieldIds) }).run();

      const response = await GET();
      const data = await response.json();

      expect(JSON.parse(data.settings.github_board_custom_field_ids)).toEqual(customFieldIds);
    });

    it('returns 502 when enabling GitHub board sync fails', async () => {
      ensureProjectBoardMock.mockRejectedValueOnce(new Error('missing project scope'));
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          github_board_sync_enabled: 'true',
          github_board_project_owner: 'octocat',
        }),
      });

      const response = await PATCH(request);

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ detail: 'missing project scope' });
    });

    it('normalizes notification_throttle_overrides before persisting them', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          notification_throttle_overrides: JSON.stringify({
            release_fail: '15',
            release_aborted: 0,
          }),
        }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      const row = testDb.db.select().from(schema.settings).all().find((r) => r.key === 'notification_throttle_overrides');
      expect(row?.value).toBe(JSON.stringify({
        release_fail: 15,
        release_aborted: 0,
      }));
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          notification_throttle_overrides: JSON.stringify({
            release_fail: 15,
            release_aborted: 0,
          }),
        }),
      });
    });

    it('rejects non-object notification_throttle_overrides payloads', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          notification_throttle_overrides: JSON.stringify(['release_fail']),
        }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: 'notification_throttle_overrides must be a JSON object.',
      });
      expect(testDb.db.select().from(schema.settings).all()).toEqual([]);
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
      vi.doMock('@/lib/shared/config', () => ({ reloadConfig: reloadConfigMock, getSettings: () => ({ jobs_paused: false }) }));
      vi.doMock('@/lib/shared/job-control', () => ({ syncJobsPauseState: vi.fn() }));

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
