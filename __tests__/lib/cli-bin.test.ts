import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } from '@/lib/shared/cli-bin';
import type { TamTamConfig } from '@/lib/shared/config';

function makeSettings(overrides: Partial<TamTamConfig> = {}): TamTamConfig {
  const base: TamTamConfig = {
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
    claude_bin: '~/.local/bin/claude',
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
    log_dir: './data/logs',
    frequency: '1h',
    daytime: false,
    weekends: false,
    base_prompt: '',
    default_model: 'fast',
    permission_mode: 'bypassPermissions',
    commit_style: '',
    review_verdict_rules: '',
    prompt_estimate_warn_tokens: 50_000,
    prompt_estimate_block_tokens: 180_000,
    jobs_paused: false,
    fix_max_iterations: 3,
    release_min_lines: 0,
    auto_pause_unfruitful_enabled: true,
    auto_pause_unfruitful_runs: 6,
    auto_pause_unfruitful_rate: 0.2,
    release_reinforce_max_iterations: 3,
    review_fix_backoff_seconds: 0,
    review_do_not_ship_action: 'pass',
    release_wall_clock_timeout_minutes: 60,
    log_retention_count: 200,
    log_retention_days: 30,
    job_row_retention_days: 180,
    workflow_run_retention_days: 30,
    backup_retention_count: 14,
    backup_retention_weekly_count: 8,
    db_backup_enabled: true,
    db_backup_interval_minutes: 15,
    mark_dod_verify_timeout_ms: 600_000,
    run_token_cap: 2_000_000,
    run_wall_time_cap_minutes: 30,
    project_failure_threshold: 3,
    project_failure_window_minutes: 60,
    notification_webhook_url: '',
    notification_webhook_secret: '',
    notification_on_release_success: false,
    notification_on_release_fail: false,
    notification_on_release_aborted: false,
    notification_on_fix_loop_exhausted: false,
    notification_on_review_do_not_ship: false,
    notification_on_agent_run_fail: false,
    notification_on_post_merge_revert: false,
    notification_on_flaky_test_detected: false,
    notification_on_circuit_breaker_tripped: false,
    notification_on_budget_exceeded: false,
    notification_throttle_window_seconds: 900,
    notification_throttle_overrides: { release_fail: 0, release_aborted: 0 },
    pipeline_model_review: '',
    pipeline_model_fix: '',
    pipeline_model_dod: '',
    pipeline_model_commit: '',
    dirty_worktree_block_threshold: 20,
    incremental_review_enabled: true,
    review_retry_on_parse_failure: true,
    budget_block_runs_enabled: false,
    budget_block_on_weekly_pace_enabled: true,
    budget_subscription_providers: ['claude', 'codex'],
    budget_block_at_pct: 95,
    budget_warn_at_pct: 80,
    notification_on_budget_blocked: false,
    retrieval_enabled: false,
    retrieval_ollama_url: 'http://localhost:11434',
    retrieval_embedding_model: 'nomic-embed-text',
    retrieval_context_limit: 5,
    retrieval_score_threshold: 0.8,
    retrieval_manage_ollama: true,
    retrieval_reindex_interval_hours: 16,
    outcome_classifier_enabled: true,
    outcome_classifier_model: 'gemma3:4b',
    project_sweep_enabled: false,
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
    initiative_engine_enabled: false,
    initiative_mining_enabled: true,
    initiative_dispatch_enabled: true,
    initiative_max_ships_per_day: 3,
    initiative_max_backlog_per_project: 50,
    initiative_mining_interval_minutes: 60,
    legacy_completion_hook_release_after_run_enabled: true,
    legacy_completion_hook_release_after_fix_ci_enabled: true,
    legacy_completion_hook_auto_resume_enabled: true,
    legacy_pipeline_lock_inline_drain_enabled: true,
    legacy_completion_hook_agent_drain_enabled: true,
    plain_test_phase_enabled: false,
  };
  return {
    ...base,
    ...overrides,
    release_min_lines: overrides.release_min_lines ?? base.release_min_lines,
    release_reinforce_max_iterations:
      overrides.release_reinforce_max_iterations ?? base.release_reinforce_max_iterations,
  };
}

describe('resolveCliBin', () => {
  let originalRoot: string | undefined;
  beforeEach(() => {
    originalRoot = process.env.TAMTAM_ROOT;
    process.env.TAMTAM_ROOT = '/tmp/tamtam-root';
  });
  afterEach(() => {
    if (originalRoot === undefined) delete process.env.TAMTAM_ROOT;
    else process.env.TAMTAM_ROOT = originalRoot;
  });

  it('returns the bundled shim path for each provider when no override is set', () => {
    const settings = makeSettings();
    expect(resolveCliBin('claude', settings)).toBe('/tmp/tamtam-root/scripts/claude-shim.js');
    expect(resolveCliBin('codex', settings)).toBe('/tmp/tamtam-root/scripts/codex-shim.js');
    expect(resolveCliBin('gemini', settings)).toBe('/tmp/tamtam-root/scripts/gemini-shim.js');
    expect(resolveCliBin('lmstudio', settings)).toBe('/tmp/tamtam-root/scripts/lmstudio-shim.js');
    expect(resolveCliBin('deepagents', settings)).toBe('/tmp/tamtam-root/scripts/deepagents-shim.js');
  });

  it('keeps non-Claude providers on the bundled shim even when an override is set', () => {
    const settings = makeSettings({
      cli_bin_claude: '/custom/claude',
      cli_bin_codex: '/custom/codex',
      cli_bin_gemini: '/custom/gemini',
    });
    expect(resolveCliBin('claude', settings)).toBe('/tmp/tamtam-root/scripts/claude-shim.js');
    expect(resolveCliBin('codex', settings)).toBe('/tmp/tamtam-root/scripts/codex-shim.js');
    expect(resolveCliBin('gemini', settings)).toBe('/tmp/tamtam-root/scripts/gemini-shim.js');
    expect(resolveCliEnv('codex', settings)).toEqual({ CODEX_BIN: '/custom/codex' });
    expect(resolveCliEnv('gemini', settings)).toEqual({ GEMINI_BIN: '/custom/gemini' });
  });

  it('forwards a custom Claude binary through CLAUDE_BIN while keeping the shim', () => {
    const settings = makeSettings({ cli_bin_claude: '/custom/claude' });
    expect(resolveCliBin('claude', settings)).toBe('/tmp/tamtam-root/scripts/claude-shim.js');
    expect(resolveCliEnv('claude', settings)).toEqual({ CLAUDE_BIN: '/custom/claude' });
  });

  it('preserves legacy claude_bin compatibility via the launch env', () => {
    const settings = makeSettings({
      claude_bin: '/legacy/claude',
      cli_bin_claude: '/legacy/claude',
    });
    expect(resolveCliBin('claude', settings)).toBe('/tmp/tamtam-root/scripts/claude-shim.js');
    expect(resolveCliEnv('claude', settings)).toEqual({ CLAUDE_BIN: '/legacy/claude' });
  });

  it('treats the LM Studio override as a base URL, not a raw executable', () => {
    const settings = makeSettings({ cli_bin_lmstudio: 'http://lmstudio.internal:1234' });
    expect(resolveCliBin('lmstudio', settings)).toBe('/tmp/tamtam-root/scripts/lmstudio-shim.js');
    expect(resolveCliEnv('lmstudio', settings)).toEqual({ LMSTUDIO_BASE_URL: 'http://lmstudio.internal:1234' });
  });

  it('ignores non-URL LM Studio overrides so the shim contract stays intact', () => {
    const settings = makeSettings({ cli_bin_lmstudio: '/custom/lmstudio' });
    expect(resolveCliBin('lmstudio', settings)).toBe('/tmp/tamtam-root/scripts/lmstudio-shim.js');
    expect(resolveCliEnv('lmstudio', settings)).toEqual({});
  });

  it('expands ~/ in the Claude binary override before exporting CLAUDE_BIN', async () => {
    const { homedir } = await import('os');
    const settings = makeSettings({ cli_bin_claude: '~/.local/bin/claude' });
    expect(resolveCliEnv('claude', settings)).toEqual({
      CLAUDE_BIN: `${homedir()}/.local/bin/claude`,
    });
  });

  it('expands a bare ~ as the home directory', async () => {
    const { homedir } = await import('os');
    const settings = makeSettings({ cli_bin_codex: '~' });
    expect(resolveCliEnv('codex', settings)).toEqual({ CODEX_BIN: homedir() });
  });

  it('does not touch absolute paths or http(s) overrides', () => {
    expect(resolveCliEnv('claude', makeSettings({ cli_bin_claude: '/abs/claude' })))
      .toEqual({ CLAUDE_BIN: '/abs/claude' });
    expect(resolveCliEnv('lmstudio', makeSettings({ cli_bin_lmstudio: 'http://lmstudio.internal:1234' })))
      .toEqual({ LMSTUDIO_BASE_URL: 'http://lmstudio.internal:1234' });
  });

  it('forwards Deep Agents executable and backend settings through env', () => {
    const settings = makeSettings({
      cli_bin_deepagents: '/opt/bin/deepagents',
      cli_deepagents_backend: 'ollama',
      cli_deepagents_base_url: 'http://ollama.internal:11434',
    });
    expect(resolveCliBin('deepagents', settings)).toBe('/tmp/tamtam-root/scripts/deepagents-shim.js');
    expect(resolveCliEnv('deepagents', settings)).toEqual({
      DEEPAGENTS_BIN: '/opt/bin/deepagents',
      DEEPAGENTS_BACKEND: 'ollama',
      DEEPAGENTS_BASE_URL: 'http://ollama.internal:11434',
    });
  });
});

describe('resolveCliDefaultModel', () => {
  it('returns the per-CLI default tier when set', () => {
    const settings = makeSettings({ cli_default_model_codex: 'fast' });
    expect(resolveCliDefaultModel('codex', settings)).toBe('fast');
  });

  it('falls back to the workspace `default_model` when the per-CLI key is empty', () => {
    const settings = makeSettings({ cli_default_model_codex: '', default_model: 'smart' });
    expect(resolveCliDefaultModel('codex', settings)).toBe('smart');
  });
});
