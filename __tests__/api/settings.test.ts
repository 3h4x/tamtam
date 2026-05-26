import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

const dbRef = vi.hoisted(() => ({ current: null as unknown as TestDbHandle['db'] }));
const syncJobsPauseStateMock = vi.hoisted(() => vi.fn());
const ensureProjectBoardMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  get db() {
    return dbRef.current;
  },
  schema,
}));

vi.mock('@/lib/shared/job-control', () => ({
  syncJobsPauseState: syncJobsPauseStateMock,
}));

vi.mock('@/lib/github/project-board', () => ({
  ensureProjectBoard: ensureProjectBoardMock,
}));

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

describe('settings API', () => {
  let sharedHandle: TestDbHandle;
  let GET: any;
  let PATCH: any;
  let reloadConfig: () => void;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
    dbRef.current = sharedHandle.db;
    const [routeMod, configMod] = await Promise.all([
      import('@/app/api/settings/route'),
      import('@/lib/shared/config'),
    ]);
    GET = routeMod.GET;
    PATCH = routeMod.PATCH;
    reloadConfig = configMod.reloadConfig;
  });

  afterAll(async () => {
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE settings'));

    syncJobsPauseStateMock.mockReset();
    ensureProjectBoardMock.mockReset();
    ensureProjectBoardMock.mockResolvedValue({
      owner: 'octocat',
      title: 'TamTam',
      projectNumber: '7',
      projectUrl: 'https://github.com/users/octocat/projects/7',
      projectId: 'PVT_x',
      statusFieldId: 'F_x',
      optionIds: { 'Todo': '1', 'In Progress': '2', 'Review': '3', 'Fixing': '4', 'Blocked': '5', 'Done': '6' },
      customFieldIds: { project: 'F_P', agent: 'F_A', kind: 'F_K', branch: 'F_B' },
    });

    // Reset config cache between tests so seeded rows don't leak from prior tests.
    reloadConfig();
  });

  describe('GET /settings', () => {
    it('returns effective CLI routing defaults initially', async () => {
      const response = await GET();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.settings).toEqual({
        claude_provider: 'claude',
        cli_enabled_providers: 'claude',
        review_fix_max_iterations: '0',
        review_do_not_ship_action: 'fix',
        release_wall_clock_timeout_minutes: '60',
        plain_test_phase_enabled: 'false',
        provider_fallback_chain: '',
      });
    });

    it('returns all stored settings', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'workspace_path', value: '/projects' });
      await sharedHandle.db.insert(schema.settings).values({ key: 'github_owner', value: 'octocat' });

      const response = await GET();
      const data = await response.json();
      expect(data.settings.workspace_path).toBe('/projects');
      expect(data.settings.github_owner).toBe('octocat');
    });

    it('does not expose removed settings left over from older releases', async () => {
      await sharedHandle.db.insert(schema.settings).values({
        key: 'durable_agent_workflows_enabled',
        value: 'true',
      });

      const response = await GET();
      const data = await response.json();

      expect(data.settings).not.toHaveProperty('durable_agent_workflows_enabled');
    });

    it('returns persisted retrieval settings', async () => {
      await sharedHandle.db.insert(schema.settings).values([
        { key: 'retrieval_enabled', value: 'false' },
        { key: 'retrieval_ollama_url', value: 'http://ollama.local:11434' },
        { key: 'retrieval_embedding_model', value: 'custom-embed' },
        { key: 'retrieval_context_limit', value: '8' },
        { key: 'retrieval_score_threshold', value: '0.65' },
        { key: 'retrieval_manage_ollama', value: 'false' },
        { key: 'retrieval_reindex_interval_hours', value: '12' },
      ]);

      const response = await GET();
      const data = await response.json();

      expect(data.settings).toMatchObject({
        retrieval_enabled: 'false',
        retrieval_ollama_url: 'http://ollama.local:11434',
        retrieval_embedding_model: 'custom-embed',
        retrieval_context_limit: '8',
        retrieval_score_threshold: '0.65',
        retrieval_manage_ollama: 'false',
        retrieval_reindex_interval_hours: '12',
      });
    });

    it('canonicalizes trusted_github_users in the API response', async () => {
      await sharedHandle.db
        .insert(schema.settings)
        .values({ key: 'trusted_github_users', value: JSON.stringify(['octocat', ' hubot ', 'OctoCat']) });

      const response = await GET();
      const data = await response.json();

      expect(data.settings.trusted_github_users).toBe('octocat, hubot');
    });

    it('canonicalizes budget subscription providers in the API response', async () => {
      await sharedHandle.db
        .insert(schema.settings)
        .values({ key: 'budget_subscription_providers', value: 'codex,gemini,codex' });

      const response = await GET();
      const data = await response.json();

      expect(data.settings.budget_subscription_providers).toBe('codex');
    });

    it('sanitizes invalid stored model settings in the API response', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'default_model', value: 'smart --resume injected' });
      await sharedHandle.db.insert(schema.settings).values({ key: 'pipeline_model_review', value: 'normal --danger' });

      const response = await GET();
      const data = await response.json();

      expect(data.settings.default_model).toBe('fast');
      expect(data.settings.pipeline_model_review).toBe('');
    });

    it('normalizes invalid stored permission_mode in the API response', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'permission_mode', value: 'dangerousMode' });

      const response = await GET();
      const data = await response.json();

      expect(data.settings.permission_mode).toBe('auto');
    });

    it('falls back to the default review_fix_max_iterations when the stored row is invalid', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'review_fix_max_iterations', value: 'abc' });

      const response = await GET();
      const data = await response.json();

      expect(data.settings.review_fix_max_iterations).toBe('0');
    });

    it('accepts zero (unlimited) as a valid review_fix_max_iterations', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'review_fix_max_iterations', value: '0' });

      const response = await GET();
      const data = await response.json();

      expect(data.settings.review_fix_max_iterations).toBe('0');
    });

    it('falls back to the default when stored review_fix_max_iterations is negative', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'review_fix_max_iterations', value: '-1' });

      const response = await GET();
      const data = await response.json();

      expect(data.settings.review_fix_max_iterations).toBe('0');
    });

    it('returns the effective review_do_not_ship_action when the stored row is invalid', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'review_do_not_ship_action', value: 'ship-it' });

      const response = await GET();
      const data = await response.json();

      expect(data.settings.review_do_not_ship_action).toBe('fix');
    });

    it('canonicalizes CLI provider and per-provider model settings in the API response', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'cli_enabled_providers', value: 'codex gemini codex' });
      await sharedHandle.db.insert(schema.settings).values({ key: 'cli_default_model_codex', value: 'sonnet' });

      // Pre-warm the (now-async) config cache so the route's `getSettings()`
      // overlay reflects the seeded rows instead of returning DEFAULTS.
      const { initSettings } = await import('@/lib/shared/config');
      await initSettings();

      const response = await GET();
      const data = await response.json();

      expect(data.settings.cli_enabled_providers).toBe('codex,gemini');
      expect(data.settings.cli_default_model_codex).toBe('normal');
    });

    it('hydrates effective CLI routing fields from legacy-only settings', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'claude_provider', value: 'codex' });
      await sharedHandle.db.insert(schema.settings).values({ key: 'claude_bin', value: '/custom/claude' });

      const { initSettings } = await import('@/lib/shared/config');
      await initSettings();

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

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find((r) => r.key === 'workspace_path');
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

      const rows = await sharedHandle.db.select().from(schema.settings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.workspace_path).toBe('/projects');
      expect(map.github_owner).toBe('octocat');
      expect(map.frequency).toBe('2h');
    });

    it('updates retrieval settings and returns their canonical values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          retrieval_enabled: false,
          retrieval_ollama_url: 'http://ollama.local:11434',
          retrieval_embedding_model: 'custom-embed',
          retrieval_context_limit: '08',
          retrieval_score_threshold: '0.70',
          retrieval_manage_ollama: 'false',
        }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(200);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map).toMatchObject({
        retrieval_enabled: 'false',
        retrieval_ollama_url: 'http://ollama.local:11434',
        retrieval_embedding_model: 'custom-embed',
        retrieval_context_limit: '8',
        retrieval_score_threshold: '0.7',
        retrieval_manage_ollama: 'false',
      });

      const data = await response.json();
      expect(data.settings).toMatchObject({
        retrieval_enabled: 'false',
        retrieval_context_limit: '8',
        retrieval_score_threshold: '0.7',
        retrieval_manage_ollama: 'false',
      });
    });

    it('updates project sweep settings and returns their canonical values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ project_sweep_enabled: true }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(200);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.project_sweep_enabled).toBe('true');

      const data = await response.json();
      expect(data.settings.project_sweep_enabled).toBe('true');
    });

    it('updates legacy completion hook kill switches and returns them canonically', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          legacy_completion_hook_release_after_run_enabled: false,
          legacy_completion_hook_release_after_fix_ci_enabled: false,
          legacy_completion_hook_auto_resume_enabled: false,
          legacy_pipeline_lock_inline_drain_enabled: false,
          legacy_completion_hook_agent_drain_enabled: false,
        }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(200);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.legacy_completion_hook_release_after_run_enabled).toBe('false');
      expect(map.legacy_completion_hook_release_after_fix_ci_enabled).toBe('false');
      expect(map.legacy_completion_hook_auto_resume_enabled).toBe('false');
      expect(map.legacy_pipeline_lock_inline_drain_enabled).toBe('false');
      expect(map.legacy_completion_hook_agent_drain_enabled).toBe('false');

      const patchData = await response.json();
      expect(patchData.settings.legacy_completion_hook_release_after_run_enabled).toBe('false');
      expect(patchData.settings.legacy_completion_hook_release_after_fix_ci_enabled).toBe('false');
      expect(patchData.settings.legacy_completion_hook_auto_resume_enabled).toBe('false');
      expect(patchData.settings.legacy_pipeline_lock_inline_drain_enabled).toBe('false');
      expect(patchData.settings.legacy_completion_hook_agent_drain_enabled).toBe('false');

      const getResponse = await GET();
      const getData = await getResponse.json();
      expect(getData.settings.legacy_completion_hook_release_after_run_enabled).toBe('false');
      expect(getData.settings.legacy_completion_hook_release_after_fix_ci_enabled).toBe('false');
      expect(getData.settings.legacy_completion_hook_auto_resume_enabled).toBe('false');
      expect(getData.settings.legacy_pipeline_lock_inline_drain_enabled).toBe('false');
      expect(getData.settings.legacy_completion_hook_agent_drain_enabled).toBe('false');
    });

    it('updates plain test phase flag and exposes it through GET and config reads', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ plain_test_phase_enabled: true }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(200);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.plain_test_phase_enabled).toBe('true');

      const patchData = await response.json();
      expect(patchData.settings.plain_test_phase_enabled).toBe('true');

      const getResponse = await GET();
      const getData = await getResponse.json();
      expect(getData.settings.plain_test_phase_enabled).toBe('true');

      const { initSettings, getSettings } = await import('@/lib/shared/config');
      await initSettings();
      expect(getSettings().plain_test_phase_enabled).toBe(true);
    });

    it('rejects invalid plain test phase flag values', async () => {
      const response = await PATCH(new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ plain_test_phase_enabled: 'sometimes' }),
      }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        detail: 'plain_test_phase_enabled must be true or false.',
      });
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('rejects invalid retrieval settings', async () => {
      const response = await PATCH(new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          retrieval_score_threshold: '1.5',
        }),
      }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('retrieval_score_threshold'),
      });
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
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

      const rows = await sharedHandle.db.select().from(schema.settings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.workspace_path).toBe('/valid');
      expect('unknown_key' in map).toBe(false);
    });

    it('deletes a setting when value is null', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'github_owner', value: 'old' });

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ github_owner: null }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const found = rows.find((r) => r.key === 'github_owner');
      expect(found).toBeUndefined();
    });

    it('deletes a setting when value is empty string', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'github_owner', value: 'old' });

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ github_owner: '' }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const found = rows.find((r) => r.key === 'github_owner');
      expect(found).toBeUndefined();
    });

    it('upserts an existing setting', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'claude_bin', value: '/old/claude' });

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ claude_bin: '/new/claude' }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
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

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'base_prompt');
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
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
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
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('saves jobs_paused and applies scheduler pause immediately', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ jobs_paused: 'true' }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'jobs_paused');
      expect(row?.value).toBe('true');
      // `getSettings()` runs a fire-and-forget refresh after `reloadConfig`,
      // so the synchronous call inside PATCH sees stale DEFAULTS. The mock
      // is called with the prior (false) value first; wait for the
      // background refresh to land and re-trigger.
      expect(syncJobsPauseStateMock).toHaveBeenCalled();
      await vi.waitFor(async () => {
        const { initSettings } = await import('@/lib/shared/config');
        await initSettings();
        // simulate the post-refresh state check the production scheduler
        // boot performs.
        const { getSettings } = await import('@/lib/shared/config');
        expect(getSettings().jobs_paused).toBe(true);
      }, { interval: 1 });
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
        'workspace_path',
        'base_prompt',
        'default_model',
        'permission_mode',
        'commit_style',
        'review_verdict_rules',
        'jobs_paused',
        'review_fix_max_iterations',
        'review_do_not_ship_action',
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
        'retrieval_reindex_interval_hours',
      ];

      const body = Object.fromEntries(validKeys.map((k) => [
        k,
        k === 'default_model' ? 'fast'
          : k === 'permission_mode' ? 'acceptEdits'
          : k.startsWith('pipeline_model_') ? 'normal'
          : k === 'review_fix_max_iterations' ? '5'
          : k === 'review_do_not_ship_action' ? 'fix'
          : k === 'release_wall_clock_timeout_minutes' ? '30'
          : k === 'retrieval_reindex_interval_hours' ? '16'
          : k === 'agent_templates'
            ? JSON.stringify([{ name: 'template', description: 'desc', model: 'smart', schedule: '', prompt: '' }])
            : 'test-value',
      ]));
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      expect(rows).toHaveLength(validKeys.length);
    });

    it('saves commit_style setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ commit_style: 'squash everything into one commit' }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'commit_style');
      expect(row?.value).toBe('squash everything into one commit');
    });

    it('saves budget subscription providers as a comma list', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ budget_subscription_providers: 'claude,codex' }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'budget_subscription_providers');
      expect(row?.value).toBe('claude,codex');
    });

    it('canonicalizes trusted_github_users before persisting them', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ trusted_github_users: 'octocat, hubot ' }),
      });
      const response = await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'trusted_github_users');
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
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
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
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('canonicalizes budget subscription providers before persisting them', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ budget_subscription_providers: 'codex,gemini,codex' }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'budget_subscription_providers');
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

      const rows = await sharedHandle.db.select().from(schema.settings);
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

      const rows = await sharedHandle.db.select().from(schema.settings);
      expect(rows.find((r) => r.key === 'cli_enabled_providers')?.value).toBe('codex');
      expect(rows.find((r) => r.key === 'claude_provider')?.value).toBe('codex');
    });

    it('preserves effective CLI routing when round-tripping legacy settings through an unrelated save', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'claude_provider', value: 'codex' });
      await sharedHandle.db.insert(schema.settings).values({ key: 'claude_bin', value: '/custom/claude' });

      const { initSettings } = await import('@/lib/shared/config');
      await initSettings();

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

      const allRows = await sharedHandle.db.select().from(schema.settings);
      const rows = Object.fromEntries(allRows.map((row) => [row.key, row.value]));
      expect(rows.github_owner).toBe('octocat');
      expect(rows.claude_provider).toBe('codex');
      expect(rows.cli_enabled_providers).toBe('codex');
      expect(rows.claude_bin).toBe('/custom/claude');
      expect(rows.cli_bin_claude).toBe('/custom/claude');
    });

    it('does not rewrite a legacy custom provider to claude on an unrelated save round-trip', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'claude_provider', value: 'custom' });
      await sharedHandle.db.insert(schema.settings).values({ key: 'claude_bin', value: '/usr/local/bin/acme-cli' });

      const { initSettings } = await import('@/lib/shared/config');
      await initSettings();

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

      const allRows = await sharedHandle.db.select().from(schema.settings);
      const rows = Object.fromEntries(allRows.map((row) => [row.key, row.value]));
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

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'review_fix_max_iterations');
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

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'review_fix_max_iterations');
      expect(row?.value).toBe('3');
    });

    it('saves review_do_not_ship_action setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_do_not_ship_action: 'abort' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'review_do_not_ship_action');
      expect(row?.value).toBe('abort');
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          review_do_not_ship_action: 'abort',
        }),
      });
    });

    it('accepts zero-valued backup retention settings and returns them canonically', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          workflow_run_retention_days: '00',
          backup_retention_count: '0',
          backup_retention_weekly_count: '00',
        }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          workflow_run_retention_days: '0',
          backup_retention_count: '0',
          backup_retention_weekly_count: '0',
        }),
      });

      const allRows = await sharedHandle.db.select().from(schema.settings);
      const rows = Object.fromEntries(allRows.map((row) => [row.key, row.value]));
      expect(rows.workflow_run_retention_days).toBe('0');
      expect(rows.backup_retention_count).toBe('0');
      expect(rows.backup_retention_weekly_count).toBe('0');
    });

    it('rejects negative workflow run retention settings', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ workflow_run_retention_days: '-1' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('workflow_run_retention_days must be a non-negative integer'),
      });
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
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
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('rejects non-numeric review_fix_max_iterations values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_fix_max_iterations: 'abc' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('review_fix_max_iterations must be a non-negative integer'),
      });
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('accepts zero review_fix_max_iterations as unlimited', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_fix_max_iterations: '0' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        settings: {
          review_fix_max_iterations: '0',
        },
      });
      const rows = await sharedHandle.db.select().from(schema.settings);
      expect(rows).toContainEqual(expect.objectContaining({
        key: 'review_fix_max_iterations',
        value: '0',
      }));
    });

    it('rejects negative review_fix_max_iterations values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_fix_max_iterations: '-1' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('review_fix_max_iterations must be a non-negative integer'),
      });
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('rejects invalid review_do_not_ship_action values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_do_not_ship_action: 'ship-it' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('review_do_not_ship_action must be one of: pass, fix, abort'),
      });
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('saves retrieval_reindex_interval_hours in canonical form', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ retrieval_reindex_interval_hours: '016' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          retrieval_reindex_interval_hours: '16',
        }),
      });

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'retrieval_reindex_interval_hours');
      expect(row?.value).toBe('16');
    });

    it('rejects out-of-range retrieval_reindex_interval_hours values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ retrieval_reindex_interval_hours: '169' }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('retrieval_reindex_interval_hours must be a positive integer between 1 and 168'),
      });
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('saves review_verdict_rules setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_verdict_rules: 'Always LGTM unless broken' }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'review_verdict_rules');
      expect(row?.value).toBe('Always LGTM unless broken');
    });

    it('saves agent_templates as a JSON string', async () => {
      const templates = [
        { name: 'security-review', description: 'Scans for OWASP issues', model: 'sonnet', schedule: '24h', prompt: 'Review the diff for security issues.' },
      ];
      const canonicalTemplates = [
        { ...templates[0], model: 'normal' },
      ];
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ agent_templates: JSON.stringify(templates) }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'agent_templates');
      expect(row?.value).toBe(JSON.stringify(canonicalTemplates));
      expect(JSON.parse(row!.value)).toEqual(canonicalTemplates);
    });

    it('rejects agent_templates with invalid model values', async () => {
      const templates = [
        { name: 'security-review', description: 'Scans for OWASP issues', model: 'smart --resume injected', schedule: '24h', prompt: 'Review the diff for security issues.' },
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
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('deletes agent_templates when set to empty string', async () => {
      await sharedHandle.db.insert(schema.settings).values({ key: 'agent_templates', value: '[{"name":"old"}]' });

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ agent_templates: '' }),
      });
      await PATCH(request);

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'agent_templates');
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
      const allRows = await sharedHandle.db.select().from(schema.settings);
      const rows = Object.fromEntries(allRows.map((row) => [row.key, row.value]));
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

      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'github_board_status_option_ids');
      expect(row?.value).toBe(JSON.stringify(optionIds));
      expect(JSON.parse(row!.value)).toEqual(optionIds);
    });

    it('round-trips github_board_status_option_ids through GET', async () => {
      const optionIds = { 'Todo': 'Q', 'In Progress': 'R' };
      await sharedHandle.db.insert(schema.settings).values({ key: 'github_board_status_option_ids', value: JSON.stringify(optionIds) });
      const response = await GET();
      const data = await response.json();
      expect(JSON.parse(data.settings.github_board_status_option_ids)).toEqual(optionIds);
    });

    it('round-trips github_board_custom_field_ids through GET', async () => {
      const customFieldIds = { project: 'P', agent: 'A', kind: 'K', branch: 'B' };
      await sharedHandle.db.insert(schema.settings).values({ key: 'github_board_custom_field_ids', value: JSON.stringify(customFieldIds) });

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
      const rows = await sharedHandle.db.select().from(schema.settings);
      const row = rows.find((r) => r.key === 'notification_throttle_overrides');
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
      expect(await sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });
  });

  describe('reloadConfig on PATCH', () => {
    it('calls reloadConfig after saving settings', async () => {
      // Spy on the real reloadConfig in @/lib/shared/config. The settings
      // route imports it via a live ESM binding so the spy intercepts the
      // call without needing vi.resetModules() / vi.doMock().
      const configMod = await import('@/lib/shared/config');
      const spy = vi.spyOn(configMod, 'reloadConfig');
      try {
        const request = new NextRequest('http://localhost/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ workspace_path: '/new/path' }),
        });
        await PATCH(request);

        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
