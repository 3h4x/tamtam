import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

describe('config', () => {
  let sharedHandle: TestDbHandle;
  let getSettings: typeof import('@/lib/shared/config').getSettings;
  let reloadConfig: typeof import('@/lib/shared/config').reloadConfig;
  let initSettings: typeof import('@/lib/shared/config').initSettings;
  let withBasePrompt: typeof import('@/lib/shared/config').withBasePrompt;
  let getPermissionModeFlag: typeof import('@/lib/shared/config').getPermissionModeFlag;
  let getPipelineModel: typeof import('@/lib/shared/config').getPipelineModel;

  /**
   * Helper: insert/update a setting then refresh the config cache so the next
   * synchronous getSettings() reflects it. The production cache is populated by
   * an async background refresh; in tests we always want a deterministic load.
   */
  async function setSetting(key: string, value: string): Promise<void> {
    await sharedHandle.db
      .insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  }

  async function refresh(): Promise<void> {
    reloadConfig();
    await initSettings();
  }

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE settings'));

    vi.doMock('@/lib/db', () => ({
      db: sharedHandle.db,
      schema,
    }));

    const config = await import('@/lib/shared/config');
    getSettings = config.getSettings;
    reloadConfig = config.reloadConfig;
    initSettings = config.initSettings;
    withBasePrompt = config.withBasePrompt;
    getPermissionModeFlag = config.getPermissionModeFlag;
    getPipelineModel = config.getPipelineModel;

    // Pre-warm the cache so the first synchronous getSettings() sees an empty
    // settings table rather than DEFAULTS-while-refresh-is-pending.
    await initSettings();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns default config when no settings exist', () => {
      const config = getSettings();

      expect(config).toEqual({
        user_name: '',
        workspace_path: '',
        github_owner: '',
        auth_token_configured: false,
        trusted_github_users: [],
        github_board_sync_enabled: false,
        github_board_project_owner: '',
        github_board_project_title: 'TamTam',
        github_board_project_number: '',
        github_board_project_url: '',
        github_board_view_url: '',
        github_board_project_id: '',
        github_board_status_field_id: '',
        github_board_status_option_ids: {},
        github_board_custom_field_ids: {},
        claude_provider: 'claude',
        claude_bin: `${process.cwd()}/scripts/claude-shim.js`,
        lmstudio_model: '',
        cli_enabled_providers: ['claude'],
        cli_bin_claude: '',
        cli_bin_codex: '',
        cli_bin_gemini: '',
        cli_bin_lmstudio: '',
        cli_bin_deepagents: '',
        cli_deepagents_backend: 'lmstudio',
        cli_deepagents_base_url: '',
        cli_default_model_claude: 'normal',
        cli_default_model_codex: 'normal',
        cli_default_model_gemini: 'normal',
        cli_default_model_lmstudio: 'normal',
        cli_default_model_deepagents: 'normal',
        provider_fallback_chain: [],
        prompt_estimate_warn_tokens: 50_000,
        prompt_estimate_block_tokens: 180_000,
        log_dir: './data/logs',
        frequency: '1h',
        daytime: false,
        weekends: false,
        base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
        default_model: 'fast',
        permission_mode: 'auto',
        commit_style: 'Use conventional commits. One line only, present tense, ≤50 chars, no trailing period. Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert.',
        review_verdict_rules: expect.stringContaining('Pragmatic verdict rules'),
        jobs_paused: false,
        fix_max_iterations: 0,
        release_min_lines: 0,
        auto_pause_unfruitful_enabled: true,
        auto_pause_unfruitful_runs: 6,
        auto_pause_unfruitful_rate: 0.2,
        release_reinforce_max_iterations: 3,
        review_fix_backoff_seconds: 30,
        review_do_not_ship_action: 'fix',
        release_wall_clock_timeout_minutes: 60,
        log_retention_count: 200,
        log_retention_days: 30,
        job_row_retention_days: 180,
        workflow_run_retention_days: 30,
        skill_revision_retention_count: 50,
        backup_retention_count: 14,
        backup_retention_weekly_count: 8,
        db_backup_enabled: true,
        db_backup_interval_minutes: 15,
        mark_dod_verify_timeout_ms: 600_000,
        notification_webhook_url: '',
        notification_webhook_secret: '',
        notification_on_release_success: false,
        notification_on_release_fail: false,
        notification_on_release_aborted: false,
        notification_on_fix_loop_exhausted: false,
        notification_on_review_do_not_ship: false,
        notification_on_agent_run_fail: false,
        notification_on_budget_blocked: false,
        notification_on_budget_exceeded: false,
        notification_on_flaky_test_detected: false,
        notification_on_circuit_breaker_tripped: false,
        notification_on_post_merge_revert: false,
        notification_throttle_window_seconds: 900,
        notification_throttle_overrides: { release_fail: 0, release_aborted: 0 },
        budget_block_runs_enabled: false,
        budget_block_on_weekly_pace_enabled: true,
        budget_subscription_providers: ['claude', 'codex'],
        budget_block_at_pct: 95,
        budget_warn_at_pct: 80,
        pipeline_model_review: '',
        pipeline_model_fix: '',
        pipeline_model_dod: '',
        pipeline_model_commit: '',
        project_sweep_enabled: false,
        review_retry_on_parse_failure: true,
        legacy_completion_hook_release_after_run_enabled: true,
        legacy_completion_hook_release_after_fix_ci_enabled: true,
        legacy_completion_hook_auto_resume_enabled: true,
        legacy_pipeline_lock_inline_drain_enabled: true,
        legacy_completion_hook_agent_drain_enabled: true,
        plain_test_phase_enabled: false,
        auto_fix_ci_on_red_default_branch: true,
        ci_gate_block_dispatch_on_red: false,
        fix_ci_bypass_sandbox: true,
        // Pre-existing gap: shipped in DEFAULTS by the uncommitted resolve-conflicts
        // work but never added to this snapshot; included here so the assertion matches.
        resolve_conflicts_bypass_sandbox: true,
        run_token_cap: 2_000_000,
        run_wall_time_cap_minutes: 30,
        project_failure_threshold: 3,
        project_failure_window_minutes: 60,
        dirty_worktree_block_threshold: 1,
        incremental_review_enabled: true,
        initiative_engine_enabled: false,
        initiative_mining_enabled: true,
        initiative_dispatch_enabled: true,
        initiative_max_ships_per_day: 3,
        initiative_max_backlog_per_project: 50,
        initiative_mining_interval_minutes: 60,
        retrieval_enabled: false,
        retrieval_ollama_url: 'http://localhost:11434',
        retrieval_embedding_model: 'nomic-embed-text',
        retrieval_context_limit: 5,
        outcome_classifier_enabled: false,
        outcome_classifier_model: 'gemma3:4b',
        retrieval_score_threshold: 0.8,
        retrieval_manage_ollama: true,
        retrieval_reindex_interval_hours: 16,
        browser_broker_enabled: false,
        browser_broker_image: 'mcr.microsoft.com/playwright/mcp:v0.0.30',
        browser_broker_mode: 'docker',
        tamtam_network_policy_strict: false,
        orchestrator_enabled: false,
        orchestrator_boost_margin_pct: 5,
        orchestrator_max_boosts_per_hour: 2,
        agent_autopilot_enabled: true,
        agent_autopilot_cadence_floor: '4h',
        agent_autopilot_tier_floor: 'fast',
        agent_autopilot_idle_streak: 4,
        agent_autopilot_concern_streak: 2,
      });
    });

    it('returns config with overridden workspace_path', async () => {
      await setSetting('workspace_path', '/home/user/projects');
      await refresh();

      const config = getSettings();

      expect(config.workspace_path).toBe('/home/user/projects');
      // claude provider routes through the tier-name shim regardless of stored value.
      expect(config.claude_bin).toBe(`${process.cwd()}/scripts/claude-shim.js`);
    });

    it('returns config with overridden github_owner', async () => {
      await setSetting('github_owner', 'octocat');
      await refresh();

      const config = getSettings();

      expect(config.github_owner).toBe('octocat');
    });

    it('normalizes the retired browser broker base image to the MCP image', async () => {
      await setSetting('browser_broker_image', 'mcr.microsoft.com/playwright:v1.59.1-noble');
      await refresh();

      const config = getSettings();

      expect(config.browser_broker_image).toBe('mcr.microsoft.com/playwright/mcp:v0.0.30');
    });

    it('parses stored GitHub board settings', async () => {
      await setSetting('github_board_sync_enabled', 'true');
      await setSetting('github_board_project_owner', 'acme');
      await setSetting('github_board_project_title', 'TamTam Ops');
      await setSetting('github_board_status_option_ids', JSON.stringify({ 'In Progress': 'opt-1' }));
      await refresh();

      const config = getSettings();

      expect(config.github_board_sync_enabled).toBe(true);
      expect(config.github_board_project_owner).toBe('acme');
      expect(config.github_board_project_title).toBe('TamTam Ops');
      expect(config.github_board_status_option_ids).toEqual({ 'In Progress': 'opt-1' });
    });

    it('returns config with overridden claude_bin', async () => {
      await setSetting('claude_bin', '/usr/bin/claude');
      await refresh();

      const config = getSettings();

      // For provider=claude, the resolved claude_bin is always the shim path —
      // the user's stored value is forwarded to the underlying binary via the
      // CLAUDE_BIN env var at spawn time, not by overriding claude_bin itself.
      expect(config.claude_bin).toBe(`${process.cwd()}/scripts/claude-shim.js`);
      expect(config.cli_bin_claude).toBe('/usr/bin/claude');
    });

    it('preserves a legacy Claude binary override even when another provider is active', async () => {
      await setSetting('claude_provider', 'codex');
      await setSetting('claude_bin', '/usr/bin/claude');
      await refresh();

      const config = getSettings();

      expect(config.claude_provider).toBe('codex');
      expect(config.cli_bin_claude).toBe('/usr/bin/claude');
    });

    it('keeps legacy custom provider routing while dropping stale shim binaries', async () => {
      await setSetting('claude_provider', 'custom');
      await setSetting('claude_bin', '/opt/tamtam/scripts/gemini-shim.js');
      await refresh();

      const config = getSettings();

      expect(config.claude_provider).toBe('custom');
      expect(config.cli_enabled_providers).toEqual(['claude']);
      expect(config.claude_bin).toBe('~/.local/bin/claude');
      expect(config.cli_bin_claude).toBe('');
    });

    it('canonicalizes legacy model aliases from settings', async () => {
      await setSetting('default_model', 'sonnet');
      await setSetting('pipeline_model_dod', 'haiku');
      await setSetting('pipeline_model_commit', 'opus');
      await refresh();

      const config = getSettings();

      expect(config.default_model).toBe('normal');
      expect(config.pipeline_model_dod).toBe('fast');
      expect(config.pipeline_model_commit).toBe('smart');
    });

    it('parses budget subscription providers from settings', async () => {
      await setSetting('budget_subscription_providers', 'codex,claude,codex');
      await refresh();

      const config = getSettings();

      expect(config.budget_subscription_providers).toEqual(['codex', 'claude']);
    });

    it('resolves Gemini provider to the bundled shim', async () => {
      await setSetting('claude_provider', 'gemini');
      await setSetting('claude_bin', '/usr/bin/claude');
      await refresh();

      const config = getSettings();

      expect(config.claude_provider).toBe('gemini');
      expect(config.claude_bin).toBe(`${process.cwd()}/scripts/gemini-shim.js`);
    });

    it('resolves LM Studio provider to the bundled shim', async () => {
      await setSetting('claude_provider', 'lmstudio');
      await refresh();

      const config = getSettings();

      expect(config.claude_provider).toBe('lmstudio');
      expect(config.claude_bin).toBe(`${process.cwd()}/scripts/lmstudio-shim.js`);
    });

    it('resolves Codex provider to the bundled shim', async () => {
      await setSetting('claude_provider', 'codex');
      await refresh();

      const config = getSettings();

      expect(config.claude_provider).toBe('codex');
      expect(config.claude_bin).toBe(`${process.cwd()}/scripts/codex-shim.js`);
    });

    it('exports configured LM Studio model to child process env', async () => {
      await setSetting('lmstudio_model', 'gemma-4-e4b-uncensored-hauhaucs-aggressive');
      await refresh();

      const config = getSettings();

      expect(config.lmstudio_model).toBe('gemma-4-e4b-uncensored-hauhaucs-aggressive');
      expect(process.env.LMSTUDIO_MODEL).toBe('gemma-4-e4b-uncensored-hauhaucs-aggressive');
    });

    it('clears stale LM Studio model env when the settings table is missing', async () => {
      await setSetting('lmstudio_model', 'gemma-4-e4b-uncensored-hauhaucs-aggressive');
      await refresh();
      expect(process.env.LMSTUDIO_MODEL).toBe('gemma-4-e4b-uncensored-hauhaucs-aggressive');

      await sharedHandle.db.execute(sql.raw('DROP TABLE settings'));
      try {
        await refresh();

        const config = getSettings();
        expect(config.lmstudio_model).toBe('');
        expect(process.env.LMSTUDIO_MODEL).toBeUndefined();
      } finally {
        await applyDdl(sharedHandle);
      }
    });

    it('infers provider from an existing shim path', async () => {
      await setSetting('claude_bin', '/opt/tamtam/scripts/lmstudio-shim.js');
      await refresh();

      const config = getSettings();

      expect(config.claude_provider).toBe('lmstudio');
      expect(config.claude_bin).toBe(`${process.cwd()}/scripts/lmstudio-shim.js`);
    });

    it('returns config with overridden log_dir', async () => {
      await setSetting('log_dir', '/var/log/tamtam');
      await refresh();

      const config = getSettings();

      expect(config.log_dir).toBe('/var/log/tamtam');
    });

    it('returns config with overridden frequency', async () => {
      await setSetting('frequency', '30m');
      await refresh();

      const config = getSettings();

      expect(config.frequency).toBe('30m');
    });

    it('parses daytime setting as boolean', async () => {
      await setSetting('daytime', 'true');
      await refresh();

      const config = getSettings();

      expect(config.daytime).toBe(true);
    });

    it('handles daytime setting as false when not "true"', async () => {
      await setSetting('daytime', 'false');
      await refresh();

      const config = getSettings();

      expect(config.daytime).toBe(false);
    });

    it('parses weekends setting as boolean from "on" value', async () => {
      await setSetting('weekends', 'on');
      await refresh();

      const config = getSettings();

      expect(config.weekends).toBe(true);
    });

    it('handles weekends setting as false when not "on"', async () => {
      await setSetting('weekends', 'off');
      await refresh();

      const config = getSettings();

      expect(config.weekends).toBe(false);
    });

    it('returns jobs_paused=true when stored in settings', async () => {
      await setSetting('jobs_paused', 'true');
      await refresh();

      const config = getSettings();

      expect(config.jobs_paused).toBe(true);
    });

    it('handles multiple settings', async () => {
      await setSetting('workspace_path', '/projects');
      await setSetting('github_owner', 'user123');
      await setSetting('frequency', '2h');
      await refresh();

      const config = getSettings();

      expect(config.workspace_path).toBe('/projects');
      expect(config.github_owner).toBe('user123');
      expect(config.frequency).toBe('2h');
      expect(config.claude_bin).toBe(`${process.cwd()}/scripts/claude-shim.js`);
    });

    it('caches config for CACHE_TTL seconds', async () => {
      await setSetting('workspace_path', '/initial');
      await refresh();

      const config1 = getSettings();
      expect(config1.workspace_path).toBe('/initial');

      // Modify database (but don't clear cache)
      await sharedHandle.db.delete(schema.settings);
      await setSetting('workspace_path', '/modified');

      // Should return cached value within TTL
      const config2 = getSettings();
      expect(config2.workspace_path).toBe('/initial');
    });

    it('returns updated config after cache expires and reload is called', async () => {
      await setSetting('workspace_path', '/initial');
      await refresh();

      const config1 = getSettings();
      expect(config1.workspace_path).toBe('/initial');

      // Modify database
      await sharedHandle.db.delete(schema.settings);
      await setSetting('workspace_path', '/modified');

      // Clear cache and pre-warm with new data
      await refresh();

      const config2 = getSettings();
      expect(config2.workspace_path).toBe('/modified');
    });
  });

  describe('reloadConfig', () => {
    it('clears the cache', async () => {
      await setSetting('workspace_path', '/initial');
      await refresh();

      const config1 = getSettings();
      expect(config1.workspace_path).toBe('/initial');

      // Modify database
      await sharedHandle.db.delete(schema.settings);
      await setSetting('workspace_path', '/updated');

      // Clear cache and pre-warm
      await refresh();

      const config2 = getSettings();
      expect(config2.workspace_path).toBe('/updated');
    });

    it('can be called multiple times', async () => {
      await setSetting('frequency', '1h');
      await refresh();

      getSettings();
      reloadConfig();
      reloadConfig();
      reloadConfig();
      await initSettings();

      const config = getSettings();
      expect(config.frequency).toBe('1h');
    });
  });

  describe('base_prompt', () => {
    it('returns default base_prompt when not set', () => {
      const config = getSettings();
      expect(config.base_prompt).toContain('Never ask clarifying questions');
    });

    it('returns custom base_prompt when set in DB', async () => {
      await setSetting('base_prompt', 'Be concise.');
      await refresh();

      const config = getSettings();
      expect(config.base_prompt).toBe('Be concise.');
    });
  });

  describe('withBasePrompt', () => {
    it('prepends default base prompt to user prompt', () => {
      const result = withBasePrompt('do something');
      expect(result).toContain('Never ask clarifying questions');
      expect(result).toContain('---');
      expect(result).toContain('do something');
    });

    it('prepends custom base prompt when configured', async () => {
      await setSetting('base_prompt', 'Be concise.');
      await refresh();

      const result = withBasePrompt('do something');
      expect(result).toBe('Be concise.\n\n---\n\ndo something');
    });

    it('returns prompt unchanged when base_prompt is empty', async () => {
      await setSetting('base_prompt', '');
      await refresh();

      // Empty string gets deleted from DB by settings API, so falls back to default
      // But if it somehow ends up empty in the map, withBasePrompt should handle it
      const result = withBasePrompt('do something');
      // With empty base_prompt in DB, getSettings returns default
      expect(result).toContain('do something');
    });

    it('preserves multiline prompts', async () => {
      await setSetting('base_prompt', 'Rule 1\nRule 2');
      await refresh();

      const result = withBasePrompt('task here');
      expect(result).toBe('Rule 1\nRule 2\n\n---\n\ntask here');
    });

    it('injects project CLAUDE.md for LM Studio provider', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tamtam-config-'));
      try {
        writeFileSync(join(dir, 'CLAUDE.md'), '# Project Rules\n\nUse pnpm.');
        await setSetting('claude_provider', 'lmstudio');
        await setSetting('base_prompt', 'Base rules.');
        await refresh();

        const result = withBasePrompt('task here', { projectPath: dir });

        expect(result).toContain('Base rules.');
        expect(result).toContain('Project instructions from CLAUDE.md');
        expect(result).toContain('Use pnpm.');
        expect(result).toContain('task here');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('uses the enabled CLI set as the active provider when deciding CLAUDE.md injection', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tamtam-config-'));
      try {
        writeFileSync(join(dir, 'CLAUDE.md'), '# Project Rules\n\nUse pnpm.');
        await setSetting('claude_provider', 'claude');
        await setSetting('cli_enabled_providers', 'codex,claude');
        await setSetting('base_prompt', 'Base rules.');
        await refresh();

        const result = withBasePrompt('task here', { projectPath: dir });

        expect(result).toContain('Project instructions from CLAUDE.md');
        expect(result).toContain('Use pnpm.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('uses an explicit run provider when deciding CLAUDE.md injection', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tamtam-config-'));
      try {
        writeFileSync(join(dir, 'CLAUDE.md'), '# Project Rules\n\nUse pnpm.');
        await setSetting('claude_provider', 'claude');
        await setSetting('base_prompt', 'Base rules.');
        await refresh();

        const result = withBasePrompt('task here', { projectPath: dir, provider: 'codex' });

        expect(result).toContain('Project instructions from CLAUDE.md');
        expect(result).toContain('Use pnpm.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not inject project CLAUDE.md for Claude provider', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tamtam-config-'));
      try {
        writeFileSync(join(dir, 'CLAUDE.md'), '# Project Rules\n\nUse pnpm.');
        await setSetting('base_prompt', 'Base rules.');
        await refresh();

        const result = withBasePrompt('task here', { projectPath: dir });

        expect(result).toBe('Base rules.\n\n---\n\ntask here');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('getPermissionModeFlag', () => {
    it('returns default auto flag when no setting in DB', () => {
      expect(getPermissionModeFlag()).toBe('--permission-mode auto');
    });

    it('returns flag for a valid mode stored in DB', async () => {
      await setSetting('permission_mode', 'acceptEdits');
      await refresh();
      expect(getPermissionModeFlag()).toBe('--permission-mode acceptEdits');
    });

    it('falls back to auto for an unrecognised mode', async () => {
      await setSetting('permission_mode', 'dangerousMode');
      await refresh();
      expect(getPermissionModeFlag()).toBe('--permission-mode auto');
    });

    it.each(['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'])(
      'accepts valid mode %s',
      async (mode) => {
        await setSetting('permission_mode', mode);
        await refresh();
        expect(getPermissionModeFlag()).toBe(`--permission-mode ${mode}`);
      }
    );

    it('uses a valid per-agent override instead of the global setting', async () => {
      await setSetting('permission_mode', 'auto');
      await refresh();
      expect(getPermissionModeFlag('bypassPermissions')).toBe('--permission-mode bypassPermissions');
    });

    it('falls back to the global setting when the override is null or unrecognized', async () => {
      await setSetting('permission_mode', 'acceptEdits');
      await refresh();
      expect(getPermissionModeFlag(null)).toBe('--permission-mode acceptEdits');
      expect(getPermissionModeFlag('yolo')).toBe('--permission-mode acceptEdits');
    });
  });

  describe('fix_max_iterations', () => {
    it('parses fix_max_iterations from DB as integer', async () => {
      await setSetting('fix_max_iterations', '5');
      await refresh();
      expect(getSettings().fix_max_iterations).toBe(5);
    });

    it('falls back to default (unlimited) when value is non-numeric', async () => {
      await setSetting('fix_max_iterations', 'abc');
      await refresh();
      expect(getSettings().fix_max_iterations).toBe(0);
    });

    it('preserves explicit zero as unlimited', async () => {
      await setSetting('fix_max_iterations', '0');
      await refresh();
      expect(getSettings().fix_max_iterations).toBe(0);
    });

    it('falls back to default (unlimited) when value is negative', async () => {
      await setSetting('fix_max_iterations', '-1');
      await refresh();
      expect(getSettings().fix_max_iterations).toBe(0);
    });

    it('returns the default 0 (unlimited) when no DB row exists', async () => {
      await refresh();
      expect(getSettings().fix_max_iterations).toBe(0);
    });
  });

  describe('retention settings', () => {
    it('returns workflow run retention defaults when no DB rows exist', async () => {
      await refresh();

      expect(getSettings().workflow_run_retention_days).toBe(30);
    });

    it('parses workflow run retention values from DB as integers', async () => {
      await setSetting('workflow_run_retention_days', '45');
      await refresh();

      expect(getSettings().workflow_run_retention_days).toBe(45);
    });

    it('preserves zero-valued workflow run retention settings from DB', async () => {
      await setSetting('workflow_run_retention_days', '0');
      await refresh();

      expect(getSettings().workflow_run_retention_days).toBe(0);
    });

    it('falls back to default when workflow run retention is non-numeric', async () => {
      await setSetting('workflow_run_retention_days', 'abc');
      await refresh();

      expect(getSettings().workflow_run_retention_days).toBe(30);
    });

    it('returns backup retention defaults when no DB rows exist', async () => {
      await refresh();

      const config = getSettings();

      expect(config.backup_retention_count).toBe(14);
      expect(config.backup_retention_weekly_count).toBe(8);
    });

    it('parses backup retention values from DB as integers', async () => {
      await setSetting('backup_retention_count', '21');
      await setSetting('backup_retention_weekly_count', '12');
      await refresh();

      const config = getSettings();

      expect(config.backup_retention_count).toBe(21);
      expect(config.backup_retention_weekly_count).toBe(12);
    });

    it('preserves zero-valued backup retention settings from DB', async () => {
      await setSetting('backup_retention_count', '0');
      await setSetting('backup_retention_weekly_count', '0');
      await refresh();

      const config = getSettings();

      expect(config.backup_retention_count).toBe(0);
      expect(config.backup_retention_weekly_count).toBe(0);
    });

    it('falls back to defaults when backup retention values are non-numeric', async () => {
      await setSetting('backup_retention_count', 'abc');
      await setSetting('backup_retention_weekly_count', 'xyz');
      await refresh();

      const config = getSettings();

      expect(config.backup_retention_count).toBe(14);
      expect(config.backup_retention_weekly_count).toBe(8);
    });
  });

  describe('notification throttle settings', () => {
    it('merges valid stored overrides with defaults and ignores invalid entries', async () => {
      await setSetting('notification_throttle_window_seconds', '120');
      await setSetting('notification_throttle_overrides', JSON.stringify({
        release_fail: '15',
        release_aborted: -1,
        fix_loop_exhausted: 30,
        review_do_not_ship: 'oops',
      }));
      await refresh();

      const config = getSettings();

      expect(config.notification_throttle_window_seconds).toBe(120);
      expect(config.notification_throttle_overrides).toEqual({
        release_fail: 15,
        release_aborted: 0,
        fix_loop_exhausted: 30,
      });
    });
  });

  describe('project sweep settings', () => {
    it('parses project_sweep_enabled from DB as a boolean', async () => {
      await setSetting('project_sweep_enabled', 'true');
      await refresh();

      expect(getSettings().project_sweep_enabled).toBe(true);
    });
  });

  describe('commit_style and review_verdict_rules', () => {
    it('returns default commit_style when not set', () => {
      const config = getSettings();
      expect(config.commit_style).toContain('conventional commits');
    });

    it('returns overridden commit_style from DB', async () => {
      await setSetting('commit_style', 'squash everything');
      await refresh();
      expect(getSettings().commit_style).toBe('squash everything');
    });

    it('returns default review_verdict_rules when not set', () => {
      const config = getSettings();
      expect(config.review_verdict_rules).toContain('Pragmatic verdict rules');
    });

    it('returns overridden review_verdict_rules from DB', async () => {
      await setSetting('review_verdict_rules', 'always LGTM');
      await refresh();
      expect(getSettings().review_verdict_rules).toBe('always LGTM');
    });
  });

  describe('getPipelineModel', () => {
    it('defaults review to the workspace default tier', () => {
      expect(getPipelineModel('review')).toBe('fast');
    });

    it('defaults fix to smart regardless of workspace default', () => {
      // Auto-fix is correctness-critical — even when default_model is `fast`,
      // fix-phase must use a high-quality model so patches don't ship broken.
      expect(getPipelineModel('fix')).toBe('smart');
    });

    it('defaults DoD and commit to fast', () => {
      expect(getPipelineModel('dod')).toBe('fast');
      expect(getPipelineModel('commit')).toBe('fast');
    });

    it('canonicalizes legacy overrides', async () => {
      await setSetting('default_model', 'opus');
      await setSetting('pipeline_model_review', 'sonnet');
      await setSetting('pipeline_model_dod', 'haiku');
      await refresh();

      expect(getPipelineModel('review')).toBe('normal');
      expect(getPipelineModel('fix')).toBe('smart');
      expect(getPipelineModel('dod')).toBe('fast');
      expect(getPipelineModel('commit')).toBe('fast');
    });

    it('falls back to safe tiers when stored model settings are invalid', async () => {
      await setSetting('default_model', 'smart --resume injected');
      await setSetting('pipeline_model_review', 'normal --danger');
      await setSetting('pipeline_model_dod', 'fast --tools injected');
      await refresh();

      expect(getSettings().default_model).toBe('fast');
      expect(getSettings().pipeline_model_review).toBe('');
      expect(getSettings().pipeline_model_dod).toBe('');
      expect(getPipelineModel('review')).toBe('fast');
      expect(getPipelineModel('dod')).toBe('fast');
    });
  });
});
