import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } from '@/lib/shared/cli-bin';
import type { TamTamConfig } from '@/lib/shared/config';

function makeSettings(overrides: Partial<TamTamConfig> = {}): TamTamConfig {
  return {
    workspace_path: '',
    github_owner: '',
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
    cli_default_model_claude: 'normal',
    cli_default_model_codex: 'normal',
    cli_default_model_gemini: 'normal',
    cli_default_model_lmstudio: 'normal',
    log_dir: './data/logs',
    frequency: '1h',
    daytime: false,
    weekends: false,
    launchagent_prefix: 'com.tamtam',
    base_prompt: '',
    default_model: 'fast',
    permission_mode: 'bypassPermissions',
    commit_style: '',
    review_verdict_rules: '',
    jobs_paused: false,
    fix_ci_max_retries: 2,
    fix_ci_retry_window_seconds: 120,
    fix_ci_fast_crash_ms: 5000,
    log_retention_count: 200,
    log_retention_days: 30,
    job_row_retention_days: 180,
    notification_webhook_url: '',
    notification_webhook_secret: '',
    notification_on_release_success: false,
    notification_on_release_fail: false,
    notification_on_release_aborted: false,
    notification_on_fix_loop_exhausted: false,
    notification_on_review_do_not_ship: false,
    notification_on_agent_run_fail: false,
    pipeline_model_review: '',
    pipeline_model_fix: '',
    pipeline_model_dod: '',
    pipeline_model_commit: '',
    review_retry_on_parse_failure: true,
    budget_block_runs_enabled: false,
    budget_subscription_providers: ['claude', 'codex'],
    budget_block_at_pct: 95,
    budget_warn_at_pct: 80,
    notification_on_budget_blocked: false,
    ...overrides,
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
