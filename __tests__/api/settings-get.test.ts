import { describe, it, expect } from 'vitest';
import * as schema from '@/lib/db/schema';
import { setupSettingsApiTest } from '@/__tests__/api/settings-fixtures';

const ctx = setupSettingsApiTest();

describe('GET /settings', () => {
    it('returns effective CLI routing defaults initially', async () => {
      const response = await ctx.GET();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.settings).toEqual({
        auth_token_configured: 'false',
        claude_provider: 'claude',
        cli_enabled_providers: 'claude',
        prompt_estimate_warn_tokens: '50000',
        prompt_estimate_block_tokens: '180000',
        fix_max_iterations: '0',
        release_min_lines: '0',
        auto_pause_unfruitful_enabled: 'true',
        auto_pause_unfruitful_runs: '6',
        auto_pause_unfruitful_rate: '0.2',
        release_reinforce_max_iterations: '3',
        review_do_not_ship_action: 'fix',
        release_wall_clock_timeout_minutes: '60',
        mark_dod_verify_timeout_ms: '600000',
        plain_test_phase_enabled: 'false',
        auto_fix_ci_on_red_default_branch: 'false',
        browser_broker_image: 'mcr.microsoft.com/playwright/mcp:v0.0.30',
        provider_fallback_chain: '',
        run_token_cap: '2000000',
        run_wall_time_cap_minutes: '30',
        project_failure_threshold: '3',
        project_failure_window_minutes: '60',
      });
    });


    it('returns all stored settings', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'workspace_path', value: '/projects' });
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'github_owner', value: 'octocat' });
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'auth_token', value: 'scrypt:v1:salt:hash' });

      const response = await ctx.GET();
      const data = await response.json();
      expect(data.settings.workspace_path).toBe('/projects');
      expect(data.settings.github_owner).toBe('octocat');
      expect(data.settings.auth_token_configured).toBe('true');
      expect(data.settings).not.toHaveProperty('auth_token');
    });


    it('does not expose removed settings left over from older releases', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({
        key: 'durable_agent_workflows_enabled',
        value: 'true',
      });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings).not.toHaveProperty('durable_agent_workflows_enabled');
    });


    it('returns persisted retrieval settings', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values([
        { key: 'retrieval_enabled', value: 'false' },
        { key: 'retrieval_ollama_url', value: 'http://ollama.local:11434' },
        { key: 'retrieval_embedding_model', value: 'custom-embed' },
        { key: 'retrieval_context_limit', value: '8' },
        { key: 'retrieval_score_threshold', value: '0.65' },
        { key: 'retrieval_manage_ollama', value: 'false' },
        { key: 'retrieval_reindex_interval_hours', value: '12' },
      ]);

      const response = await ctx.GET();
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
      await ctx.sharedHandle.db
        .insert(schema.settings)
        .values({ key: 'trusted_github_users', value: JSON.stringify(['octocat', ' hubot ', 'OctoCat']) });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.trusted_github_users).toBe('octocat, hubot');
    });


    it('canonicalizes budget subscription providers in the API response', async () => {
      await ctx.sharedHandle.db
        .insert(schema.settings)
        .values({ key: 'budget_subscription_providers', value: 'codex,gemini,codex' });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.budget_subscription_providers).toBe('codex');
    });


    it('sanitizes invalid stored model settings in the API response', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'default_model', value: 'smart --resume injected' });
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'pipeline_model_review', value: 'normal --danger' });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.default_model).toBe('fast');
      expect(data.settings.pipeline_model_review).toBe('');
    });


    it('normalizes invalid stored permission_mode in the API response', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'permission_mode', value: 'dangerousMode' });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.permission_mode).toBe('auto');
    });


    it('normalizes the retired browser broker image in the API response', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({
        key: 'browser_broker_image',
        value: 'mcr.microsoft.com/playwright:v1.59.1-noble',
      });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.browser_broker_image).toBe('mcr.microsoft.com/playwright/mcp:v0.0.30');
    });


    it('falls back to the default fix_max_iterations when the stored row is invalid', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'fix_max_iterations', value: 'abc' });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.fix_max_iterations).toBe('0');
    });


    it('accepts zero (unlimited) as a valid fix_max_iterations', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'fix_max_iterations', value: '0' });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.fix_max_iterations).toBe('0');
    });


    it('falls back to the default when stored fix_max_iterations is negative', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'fix_max_iterations', value: '-1' });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.fix_max_iterations).toBe('0');
    });


    it('returns the effective review_do_not_ship_action when the stored row is invalid', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'review_do_not_ship_action', value: 'ship-it' });

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.review_do_not_ship_action).toBe('fix');
    });


    it('canonicalizes CLI provider and per-provider model settings in the API response', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'cli_enabled_providers', value: 'codex gemini codex' });
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'cli_default_model_codex', value: 'sonnet' });

      // Pre-warm the (now-async) config cache so the route's `getSettings()`
      // overlay reflects the seeded rows instead of returning DEFAULTS.
      const { initSettings } = await import('@/lib/shared/config');
      await initSettings();

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.cli_enabled_providers).toBe('codex,gemini');
      expect(data.settings.cli_default_model_codex).toBe('normal');
    });


    it('hydrates effective CLI routing fields from legacy-only settings', async () => {
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'claude_provider', value: 'codex' });
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'claude_bin', value: '/custom/claude' });

      const { initSettings } = await import('@/lib/shared/config');
      await initSettings();

      const response = await ctx.GET();
      const data = await response.json();

      expect(data.settings.claude_provider).toBe('codex');
      expect(data.settings.cli_enabled_providers).toBe('codex');
      expect(data.settings.cli_bin_claude).toBe('/custom/claude');
      expect(data.settings.claude_bin).toBe('/custom/claude');
    });
});
