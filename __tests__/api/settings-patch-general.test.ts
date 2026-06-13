import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as schema from '@/lib/db/schema';
import { setupSettingsApiTest, syncJobsPauseStateMock } from '@/__tests__/api/settings-fixtures';

const ctx = setupSettingsApiTest();

describe('PATCH /settings persistence', () => {
    it('updates a setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ workspace_path: '/home/user/projects' }),
      });
      const response = await ctx.PATCH(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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
      const response = await ctx.PATCH(request);
      expect(response.status).toBe(200);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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
      const response = await ctx.PATCH(request);
      expect(response.status).toBe(200);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.project_sweep_enabled).toBe('true');

      const data = await response.json();
      expect(data.settings.project_sweep_enabled).toBe('true');
    });


    it('canonicalizes retired browser broker images on save', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          browser_broker_image: 'mcr.microsoft.com/playwright:v1.59.1-noble',
        }),
      });
      const response = await ctx.PATCH(request);
      expect(response.status).toBe(200);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find((r) => r.key === 'browser_broker_image');
      expect(row?.value).toBe('mcr.microsoft.com/playwright/mcp:v0.0.30');

      const data = await response.json();
      expect(data.settings.browser_broker_image).toBe('mcr.microsoft.com/playwright/mcp:v0.0.30');
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
      const response = await ctx.PATCH(request);
      expect(response.status).toBe(200);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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

      const getResponse = await ctx.GET();
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
      const response = await ctx.PATCH(request);
      expect(response.status).toBe(200);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.plain_test_phase_enabled).toBe('true');

      const patchData = await response.json();
      expect(patchData.settings.plain_test_phase_enabled).toBe('true');

      const getResponse = await ctx.GET();
      const getData = await getResponse.json();
      expect(getData.settings.plain_test_phase_enabled).toBe('true');

      const { initSettings, getSettings } = await import('@/lib/shared/config');
      await initSettings();
      expect(getSettings().plain_test_phase_enabled).toBe(true);
    });


    it('ignores unknown keys', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ unknown_key: 'value', workspace_path: '/valid' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(map.workspace_path).toBe('/valid');
      expect('unknown_key' in map).toBe(false);
    });


    it('deletes a setting when value is null', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'github_owner', value: 'old' });

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ github_owner: null }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const found = rows.find((r) => r.key === 'github_owner');
      expect(found).toBeUndefined();
    });


    it('deletes a setting when value is empty string', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'github_owner', value: 'old' });

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ github_owner: '' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const found = rows.find((r) => r.key === 'github_owner');
      expect(found).toBeUndefined();
    });


    it('upserts an existing setting', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'claude_bin', value: '/old/claude' });

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ claude_bin: '/new/claude' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const claudeRows = rows.filter((r) => r.key === 'claude_bin');
      expect(claudeRows).toHaveLength(1);
      expect(claudeRows[0].value).toBe('/new/claude');
    });


    it('saves and retrieves base_prompt', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ base_prompt: 'Be direct. No questions.' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'base_prompt');
      expect(row?.value).toBe('Be direct. No questions.');
    });


    it('saves jobs_paused and applies scheduler pause immediately', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ jobs_paused: 'true' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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
        'fix_max_iterations',
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
          : k === 'fix_max_iterations' ? '5'
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
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      expect(rows).toHaveLength(validKeys.length);
    });


    it('saves commit_style setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ commit_style: 'squash everything into one commit' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'commit_style');
      expect(row?.value).toBe('squash everything into one commit');
    });


    it('saves budget subscription providers as a comma list', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ budget_subscription_providers: 'claude,codex' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'budget_subscription_providers');
      expect(row?.value).toBe('claude,codex');
    });


    it('canonicalizes trusted_github_users before persisting them', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ trusted_github_users: 'octocat, hubot ' }),
      });
      const response = await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'trusted_github_users');
      expect(row?.value).toBe(JSON.stringify(['octocat', 'hubot']));
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          trusted_github_users: 'octocat, hubot',
        }),
      });
    });


    it('canonicalizes budget subscription providers before persisting them', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ budget_subscription_providers: 'codex,gemini,codex' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      expect(rows.find((r) => r.key === 'cli_enabled_providers')?.value).toBe('codex');
      expect(rows.find((r) => r.key === 'claude_provider')?.value).toBe('codex');
    });


    it('preserves effective CLI routing when round-tripping legacy settings through an unrelated save', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'claude_provider', value: 'codex' });
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'claude_bin', value: '/custom/claude' });

      const { initSettings } = await import('@/lib/shared/config');
      await initSettings();

      const getResponse = await ctx.GET();
      const loaded = await getResponse.json();

      const patchRequest = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          ...loaded.settings,
          github_owner: 'octocat',
        }),
      });
      await ctx.PATCH(patchRequest);

      const allRows = await ctx.sharedHandle.db.select().from(schema.settings);
      const rows = Object.fromEntries(allRows.map((row) => [row.key, row.value]));
      expect(rows.github_owner).toBe('octocat');
      expect(rows.claude_provider).toBe('codex');
      expect(rows.cli_enabled_providers).toBe('codex');
      expect(rows.claude_bin).toBe('/custom/claude');
      expect(rows.cli_bin_claude).toBe('/custom/claude');
    });


    it('does not rewrite a legacy custom provider to claude on an unrelated save round-trip', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'claude_provider', value: 'custom' });
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'claude_bin', value: '/usr/local/bin/acme-cli' });

      const { initSettings } = await import('@/lib/shared/config');
      await initSettings();

      const getResponse = await ctx.GET();
      const loaded = await getResponse.json();

      const patchRequest = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          ...loaded.settings,
          github_owner: 'octocat',
        }),
      });
      await ctx.PATCH(patchRequest);

      const allRows = await ctx.sharedHandle.db.select().from(schema.settings);
      const rows = Object.fromEntries(allRows.map((row) => [row.key, row.value]));
      expect(rows.github_owner).toBe('octocat');
      expect(rows.claude_provider).toBe('custom');
      expect(rows.cli_enabled_providers).toBe('claude');
      expect(rows.claude_bin).toBe('/usr/local/bin/acme-cli');
      expect(rows.cli_bin_claude).toBe('/usr/local/bin/acme-cli');
    });


    it('saves fix_max_iterations setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ fix_max_iterations: '5' }),
      });
      const response = await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'fix_max_iterations');
      expect(row?.value).toBe('5');
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          fix_max_iterations: '5',
        }),
      });
    });


    it('returns canonicalized fix_max_iterations in PATCH responses', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ fix_max_iterations: '03' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          fix_max_iterations: '3',
        }),
      });

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'fix_max_iterations');
      expect(row?.value).toBe('3');
    });


    it('saves review_do_not_ship_action setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_do_not_ship_action: 'abort' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(200);
      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          workflow_run_retention_days: '0',
          backup_retention_count: '0',
          backup_retention_weekly_count: '0',
        }),
      });

      const allRows = await ctx.sharedHandle.db.select().from(schema.settings);
      const rows = Object.fromEntries(allRows.map((row) => [row.key, row.value]));
      expect(rows.workflow_run_retention_days).toBe('0');
      expect(rows.backup_retention_count).toBe('0');
      expect(rows.backup_retention_weekly_count).toBe('0');
    });


    it('accepts zero fix_max_iterations as unlimited', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ fix_max_iterations: '0' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        settings: {
          fix_max_iterations: '0',
        },
      });
      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      expect(rows).toContainEqual(expect.objectContaining({
        key: 'fix_max_iterations',
        value: '0',
      }));
    });


    it('saves retrieval_reindex_interval_hours in canonical form', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ retrieval_reindex_interval_hours: '016' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ok',
        settings: expect.objectContaining({
          retrieval_reindex_interval_hours: '16',
        }),
      });

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'retrieval_reindex_interval_hours');
      expect(row?.value).toBe('16');
    });


    it('saves review_verdict_rules setting', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_verdict_rules: 'Always LGTM unless broken' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'agent_templates');
      expect(row?.value).toBe(JSON.stringify(canonicalTemplates));
      expect(JSON.parse(row!.value)).toEqual(canonicalTemplates);
    });


    it('deletes agent_templates when set to empty string', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'agent_templates', value: '[{"name":"old"}]' });

      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ agent_templates: '' }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'agent_templates');
      expect(row).toBeUndefined();
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
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(200);
      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
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
});
