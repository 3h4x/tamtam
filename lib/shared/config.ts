import { db, schema } from '@/lib/db';
import { join } from 'path';
import { readFileSync } from 'fs';
import {
  normalizeBudgetSubscriptionProviders,
  type BudgetSubscriptionProvider,
} from '@/lib/usage/subscription-providers';
import { normalizeModelInput, resolveModelAlias } from '@/lib/agents/model-aliases';
import { isCliProvider, parseEnabledProviders, type CliProvider } from '@/lib/usage/cli-providers';

/**
 * Read all settings from the DB and return as a config object.
 * All settings are stored in the DB settings table.
 */

export type ReviewDoNotShipAction = 'pass' | 'fix' | 'abort';

export const REVIEW_DO_NOT_SHIP_ACTIONS: readonly ReviewDoNotShipAction[] = ['pass', 'fix', 'abort'];

function parseReviewDoNotShipAction(
  raw: string | undefined,
  fallback: ReviewDoNotShipAction,
): ReviewDoNotShipAction {
  if (raw && (REVIEW_DO_NOT_SHIP_ACTIONS as readonly string[]).includes(raw)) {
    return raw as ReviewDoNotShipAction;
  }
  return fallback;
}

export interface TamTamConfig {
  workspace_path: string;
  github_owner: string;
  trusted_github_users: string[];
  github_board_sync_enabled: boolean;
  github_board_project_owner: string;
  github_board_project_title: string;
  github_board_project_number: string;
  github_board_project_url: string;
  github_board_view_url: string;
  github_board_project_id: string;
  github_board_status_field_id: string;
  github_board_status_option_ids: Partial<Record<import('@/lib/github/project-board-status').BoardStatus, string>>;
  github_board_custom_field_ids: Partial<Record<'project' | 'agent' | 'kind' | 'branch', string>>;
  claude_provider: string;
  claude_bin: string;
  lmstudio_model: string;
  cli_enabled_providers: import('@/lib/usage/cli-providers').CliProvider[];
  cli_bin_claude: string;
  cli_bin_codex: string;
  cli_bin_gemini: string;
  cli_bin_lmstudio: string;
  cli_bin_deepagents: string;
  cli_deepagents_backend: string;
  cli_deepagents_base_url: string;
  cli_default_model_claude: string;
  cli_default_model_codex: string;
  cli_default_model_gemini: string;
  cli_default_model_lmstudio: string;
  cli_default_model_deepagents: string;
  provider_fallback_chain: CliProvider[];
  log_dir: string;
  frequency: string;
  daytime: boolean;
  weekends: boolean;
  base_prompt: string;
  default_model: string;
  permission_mode: string;
  commit_style: string;
  review_verdict_rules: string;
  jobs_paused: boolean;
  review_fix_max_iterations: number;
  review_fix_backoff_seconds: number;
  review_do_not_ship_action: ReviewDoNotShipAction;
  release_wall_clock_timeout_minutes: number;
  log_retention_count: number;
  log_retention_days: number;
  job_row_retention_days: number;
  workflow_run_retention_days: number;
  backup_retention_count: number;
  backup_retention_weekly_count: number;
  db_backup_enabled: boolean;
  db_backup_interval_minutes: number;
  notification_webhook_url: string;
  notification_webhook_secret: string;
  notification_on_release_success: boolean;
  notification_on_release_fail: boolean;
  notification_on_release_aborted: boolean;
  notification_on_fix_loop_exhausted: boolean;
  notification_on_review_do_not_ship: boolean;
  notification_on_agent_run_fail: boolean;
  notification_on_post_merge_revert: boolean;
  notification_throttle_window_seconds: number;
  notification_throttle_overrides: Record<string, number>;
  pipeline_model_review: string;
  pipeline_model_fix: string;
  pipeline_model_dod: string;
  pipeline_model_commit: string;
  review_retry_on_parse_failure: boolean;
  legacy_completion_hook_release_after_run_enabled: boolean;
  legacy_completion_hook_release_after_fix_ci_enabled: boolean;
  legacy_completion_hook_auto_resume_enabled: boolean;
  legacy_pipeline_lock_inline_drain_enabled: boolean;
  legacy_completion_hook_agent_drain_enabled: boolean;
  plain_test_phase_enabled: boolean;
  budget_block_runs_enabled: boolean;
  budget_block_on_weekly_pace_enabled: boolean;
  budget_subscription_providers: BudgetSubscriptionProvider[];
  budget_block_at_pct: number;
  budget_warn_at_pct: number;
  notification_on_budget_blocked: boolean;
  dirty_worktree_block_threshold: number;
  incremental_review_enabled: boolean;
  retrieval_enabled: boolean;
  retrieval_ollama_url: string;
  retrieval_embedding_model: string;
  retrieval_context_limit: number;
  retrieval_score_threshold: number;
  retrieval_manage_ollama: boolean;
  retrieval_reindex_interval_hours: number;
  outcome_classifier_enabled: boolean;
  outcome_classifier_model: string;
  project_sweep_enabled: boolean;
}

const DEFAULTS: TamTamConfig = {
  workspace_path: '',
  github_owner: '',
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
  base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
  default_model: 'fast',
  permission_mode: 'auto',
  commit_style: 'Use conventional commits. One line only, present tense, ≤50 chars, no trailing period. Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert.',
  review_verdict_rules: `Pragmatic verdict rules — the release pipeline needs to actually reach LGTM sometimes:
- LGTM when the change is safe to ship. Cosmetic nits, dead imports, orphan state, style inconsistencies, or "consider…" / "nice-to-have" suggestions do NOT block LGTM — mention them as non-blocking notes if you must, but still say LGTM. The bar is: "would you merge this yourself?"
- NEEDS ATTENTION when there is at least one genuine correctness or UX issue that you'd want fixed before merge, but no risk of breakage. Missing error handling on a path that matters, wrong business logic, broken types, a test that masks behavior — that's NEEDS ATTENTION.
- DO NOT SHIP for real risk: data loss, security regression, guaranteed production breakage.
- Prefer LGTM over NEEDS ATTENTION when in doubt. Do not list every stylistic opinion. Aim for fewer than 3 findings — if you have more, the review has drifted into nitpicking.
- Keep LGTM responses short: one sentence confirmation is enough.`,
  jobs_paused: false,
  review_fix_max_iterations: 3,
  review_fix_backoff_seconds: 0,
  review_do_not_ship_action: 'fix',
  release_wall_clock_timeout_minutes: 60,
  log_retention_count: 200,
  log_retention_days: 30,
  job_row_retention_days: 180,
  workflow_run_retention_days: 30,
  backup_retention_count: 14,
  backup_retention_weekly_count: 8,
  db_backup_enabled: true,
  db_backup_interval_minutes: 15,
  notification_webhook_url: '',
  notification_webhook_secret: '',
  notification_on_release_success: false,
  notification_on_release_fail: false,
  notification_on_release_aborted: false,
  notification_on_fix_loop_exhausted: false,
  notification_on_review_do_not_ship: false,
  notification_on_agent_run_fail: false,
  notification_on_post_merge_revert: false,
  notification_throttle_window_seconds: 900,
  notification_throttle_overrides: { release_fail: 0, release_aborted: 0 },
  // Empty string = use the per-step sensible default (review/fix → workspace
  // default_model; dod/commit → fast since they're cheap classification tasks).
  pipeline_model_review: '',
  pipeline_model_fix: '',
  pipeline_model_dod: '',
  pipeline_model_commit: '',
  review_retry_on_parse_failure: true,
  legacy_completion_hook_release_after_run_enabled: true,
  legacy_completion_hook_release_after_fix_ci_enabled: true,
  legacy_completion_hook_auto_resume_enabled: true,
  legacy_pipeline_lock_inline_drain_enabled: true,
  legacy_completion_hook_agent_drain_enabled: true,
  plain_test_phase_enabled: false,
  budget_block_runs_enabled: false,
  budget_block_on_weekly_pace_enabled: true,
  budget_subscription_providers: ['claude', 'codex'],
  budget_block_at_pct: 95,
  budget_warn_at_pct: 80,
  notification_on_budget_blocked: false,
  dirty_worktree_block_threshold: 1,
  incremental_review_enabled: true,
  retrieval_enabled: true,
  retrieval_ollama_url: 'http://localhost:11434',
  retrieval_embedding_model: 'nomic-embed-text',
  retrieval_context_limit: 5,
  retrieval_score_threshold: 0.8,
  retrieval_manage_ollama: true,
  retrieval_reindex_interval_hours: 16,
  outcome_classifier_enabled: false,
  outcome_classifier_model: 'gemma3:4b',
  project_sweep_enabled: false,
};

let _cache: { config: TamTamConfig; time: number } | null = null;
let _refreshing = false;
const CACHE_TTL = 5; // seconds

/** Pre-warm the settings cache at startup. Call once before serving requests. */
export async function initSettings(): Promise<void> {
  await _doSettingsRefresh();
}

const VALID_CLAUDE_PROVIDERS = new Set(['claude', 'gemini', 'lmstudio', 'codex', 'deepagents', 'custom']);
const PROJECT_MEMORY_PROVIDERS = new Set(['gemini', 'lmstudio', 'codex', 'deepagents']);

function shimPath(name: string): string {
  return join(process.env.TAMTAM_ROOT || process.cwd(), 'scripts', name);
}

function isShimPath(bin: string | undefined): boolean {
  if (!bin) return false;
  return /scripts\/(claude|gemini|lmstudio|codex|deepagents)-shim\.js$/.test(bin);
}

function inferClaudeProvider(claudeBin: string | undefined): string {
  if (!claudeBin) return DEFAULTS.claude_provider;
  if (claudeBin.endsWith('/scripts/gemini-shim.js') || claudeBin.endsWith('scripts/gemini-shim.js')) return 'gemini';
  if (claudeBin.endsWith('/scripts/lmstudio-shim.js') || claudeBin.endsWith('scripts/lmstudio-shim.js')) return 'lmstudio';
  if (claudeBin.endsWith('/scripts/codex-shim.js') || claudeBin.endsWith('scripts/codex-shim.js')) return 'codex';
  if (claudeBin.endsWith('/scripts/deepagents-shim.js') || claudeBin.endsWith('scripts/deepagents-shim.js')) return 'deepagents';
  if (claudeBin.endsWith('/scripts/claude-shim.js') || claudeBin.endsWith('scripts/claude-shim.js')) return 'claude';
  if (claudeBin === DEFAULTS.claude_bin || claudeBin.endsWith('/claude') || claudeBin === 'claude') return 'claude';
  return 'custom';
}

function resolveEnabledProviders(raw: string | undefined, legacyProvider: string): CliProvider[] {
  const parsed = parseEnabledProviders(raw);
  if (parsed.length > 0) return parsed;
  // Fallback: treat the legacy single-select `claude_provider` value as a
  // one-element enabled set so existing installs keep working until the user
  // saves the CLI tab for the first time. `custom` is mapped to `claude` since
  // we don't track it as a routable provider in the new model.
  if (legacyProvider === 'codex' || legacyProvider === 'gemini' || legacyProvider === 'lmstudio' || legacyProvider === 'deepagents') {
    return [legacyProvider];
  }
  return ['claude'];
}

export function getActiveCliProvider(config: Pick<TamTamConfig, 'cli_enabled_providers' | 'claude_provider'>): CliProvider {
  if (Array.isArray(config.cli_enabled_providers) && config.cli_enabled_providers.length > 0) {
    return config.cli_enabled_providers[0];
  }
  return isCliProvider(config.claude_provider) ? config.claude_provider : 'claude';
}

function resolveClaudeBin(provider: string, storedBin: string | undefined): string {
  if (provider === 'gemini') return shimPath('gemini-shim.js');
  if (provider === 'lmstudio') return shimPath('lmstudio-shim.js');
  if (provider === 'codex') return shimPath('codex-shim.js');
  if (provider === 'deepagents') return shimPath('deepagents-shim.js');
  // The Claude CLI doesn't accept TamTam's tier names (`fast`/`normal`/`smart`)
  // for `--model`. Route through scripts/claude-shim.js, which translates the
  // tier name to a Claude alias and execs the real binary (default
  // `~/.local/bin/claude`, override with CLAUDE_BIN env var).
  if (provider === 'claude') return shimPath('claude-shim.js');
  // For custom providers, ignore stored shim paths left over from a prior
  // gemini/lmstudio configuration — they would invoke the wrong backend.
  if (isShimPath(storedBin)) return DEFAULTS.claude_bin;
  return storedBin ?? DEFAULTS.claude_bin;
}

/**
 * Synchronous settings accessor. Returns cached config; triggers a background async refresh
 * when the cache expires. Call `initSettings()` at startup to pre-warm the cache.
 */
export function getSettings(): TamTamConfig {
  const now = Date.now() / 1000;
  if (_cache && now - _cache.time < CACHE_TTL) return _cache.config;

  // Trigger async background refresh; don't block the caller.
  if (!_refreshing) {
    _refreshing = true;
    _doSettingsRefresh()
      .finally(() => { _refreshing = false; })
      .catch(e => console.error('[config] settings background refresh failed:', e));
  }

  return _cache?.config ?? DEFAULTS;
}

async function _doSettingsRefresh(): Promise<void> {
  const rows = await db.select().from(schema.settings);
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;
  const config = buildConfigFromSettingsMap(map);
  _cache = { config, time: Date.now() / 1000 };
  if (config.lmstudio_model) {
    process.env.LMSTUDIO_MODEL = config.lmstudio_model;
  } else {
    delete process.env.LMSTUDIO_MODEL;
  }
}

export function buildConfigFromSettingsMap(map: Record<string, string>): TamTamConfig {
  const provider = VALID_CLAUDE_PROVIDERS.has(map.claude_provider)
    ? map.claude_provider
    : inferClaudeProvider(map.claude_bin);

  const config: TamTamConfig = {
    workspace_path: map.workspace_path ?? DEFAULTS.workspace_path,
    github_owner: map.github_owner ?? DEFAULTS.github_owner,
    trusted_github_users: parseJsonStringArray(map.trusted_github_users),
    github_board_sync_enabled: map.github_board_sync_enabled === 'true',
    github_board_project_owner: map.github_board_project_owner ?? DEFAULTS.github_board_project_owner,
    github_board_project_title: map.github_board_project_title ?? DEFAULTS.github_board_project_title,
    github_board_project_number: map.github_board_project_number ?? DEFAULTS.github_board_project_number,
    github_board_project_url: map.github_board_project_url ?? DEFAULTS.github_board_project_url,
    github_board_view_url: map.github_board_view_url ?? DEFAULTS.github_board_view_url,
    github_board_project_id: map.github_board_project_id ?? DEFAULTS.github_board_project_id,
    github_board_status_field_id: map.github_board_status_field_id ?? DEFAULTS.github_board_status_field_id,
    github_board_status_option_ids: parseJsonObject(map.github_board_status_option_ids),
    github_board_custom_field_ids: parseJsonObject(map.github_board_custom_field_ids),
    claude_provider: provider,
    claude_bin: resolveClaudeBin(provider, map.claude_bin),
    lmstudio_model: map.lmstudio_model ?? DEFAULTS.lmstudio_model,
    cli_enabled_providers: resolveEnabledProviders(map.cli_enabled_providers, provider),
    cli_bin_claude:
      map.cli_bin_claude
      ?? (
        map.claude_bin &&
        !isShimPath(map.claude_bin)
          ? map.claude_bin
          : DEFAULTS.cli_bin_claude
      ),
    cli_bin_codex: map.cli_bin_codex ?? DEFAULTS.cli_bin_codex,
    cli_bin_gemini: map.cli_bin_gemini ?? DEFAULTS.cli_bin_gemini,
    cli_bin_lmstudio: map.cli_bin_lmstudio ?? DEFAULTS.cli_bin_lmstudio,
    cli_bin_deepagents: map.cli_bin_deepagents ?? DEFAULTS.cli_bin_deepagents,
    cli_deepagents_backend: map.cli_deepagents_backend === 'ollama' ? 'ollama' : DEFAULTS.cli_deepagents_backend,
    cli_deepagents_base_url: map.cli_deepagents_base_url ?? DEFAULTS.cli_deepagents_base_url,
    cli_default_model_claude: normalizeModelInput(map.cli_default_model_claude, 'normal'),
    cli_default_model_codex: normalizeModelInput(map.cli_default_model_codex, 'normal'),
    cli_default_model_gemini: normalizeModelInput(map.cli_default_model_gemini, 'normal'),
    cli_default_model_lmstudio: normalizeModelInput(map.cli_default_model_lmstudio, 'normal'),
    cli_default_model_deepagents: normalizeModelInput(map.cli_default_model_deepagents, 'normal'),
    provider_fallback_chain: parseEnabledProviders(map.provider_fallback_chain),
    log_dir: map.log_dir ?? DEFAULTS.log_dir,
    frequency: map.frequency ?? DEFAULTS.frequency,
    daytime: map.daytime === 'true',
    weekends: map.weekends === 'on',
    base_prompt: map.base_prompt ?? DEFAULTS.base_prompt,
    default_model: normalizeModelInput(map.default_model, DEFAULTS.default_model as 'fast'),
    permission_mode: map.permission_mode ?? DEFAULTS.permission_mode,
    commit_style: map.commit_style ?? DEFAULTS.commit_style,
    review_verdict_rules: map.review_verdict_rules ?? DEFAULTS.review_verdict_rules,
    jobs_paused: map.jobs_paused === 'true',
    review_fix_max_iterations: parseNonNegativeIntOr(map.review_fix_max_iterations, DEFAULTS.review_fix_max_iterations),
    review_fix_backoff_seconds: parseNonNegativeIntOr(map.review_fix_backoff_seconds, DEFAULTS.review_fix_backoff_seconds),
    review_do_not_ship_action: parseReviewDoNotShipAction(
      map.review_do_not_ship_action,
      DEFAULTS.review_do_not_ship_action,
    ),
    release_wall_clock_timeout_minutes: parsePositiveIntOr(
      map.release_wall_clock_timeout_minutes,
      DEFAULTS.release_wall_clock_timeout_minutes
    ),
    log_retention_count: parseIntOr(map.log_retention_count, DEFAULTS.log_retention_count),
    log_retention_days: parseIntOr(map.log_retention_days, DEFAULTS.log_retention_days),
    job_row_retention_days: parseIntOr(map.job_row_retention_days, DEFAULTS.job_row_retention_days),
    workflow_run_retention_days: parseIntOr(map.workflow_run_retention_days, DEFAULTS.workflow_run_retention_days),
    backup_retention_count: parseIntOr(map.backup_retention_count, DEFAULTS.backup_retention_count),
    backup_retention_weekly_count: parseIntOr(map.backup_retention_weekly_count, DEFAULTS.backup_retention_weekly_count),
    db_backup_enabled: map.db_backup_enabled === undefined
      ? DEFAULTS.db_backup_enabled
      : map.db_backup_enabled === 'true',
    db_backup_interval_minutes: parsePositiveIntOr(map.db_backup_interval_minutes, DEFAULTS.db_backup_interval_minutes),
    notification_webhook_url: map.notification_webhook_url ?? DEFAULTS.notification_webhook_url,
    notification_webhook_secret: map.notification_webhook_secret ?? DEFAULTS.notification_webhook_secret,
    notification_on_release_success: map.notification_on_release_success === 'true',
    notification_on_release_fail: map.notification_on_release_fail === 'true',
    notification_on_release_aborted: map.notification_on_release_aborted === 'true',
    notification_on_fix_loop_exhausted: map.notification_on_fix_loop_exhausted === 'true',
    notification_on_review_do_not_ship: map.notification_on_review_do_not_ship === 'true',
    notification_on_agent_run_fail: map.notification_on_agent_run_fail === 'true',
    notification_on_post_merge_revert: map.notification_on_post_merge_revert === 'true',
    notification_throttle_window_seconds: parseIntOr(
      map.notification_throttle_window_seconds,
      DEFAULTS.notification_throttle_window_seconds
    ),
    notification_throttle_overrides: parseJsonNumberMap(
      map.notification_throttle_overrides,
      DEFAULTS.notification_throttle_overrides
    ),
    pipeline_model_review: resolveModelAlias(map.pipeline_model_review),
    pipeline_model_fix: resolveModelAlias(map.pipeline_model_fix),
    pipeline_model_dod: resolveModelAlias(map.pipeline_model_dod),
    pipeline_model_commit: resolveModelAlias(map.pipeline_model_commit),
    review_retry_on_parse_failure:
      map.review_retry_on_parse_failure === undefined
        ? DEFAULTS.review_retry_on_parse_failure
        : map.review_retry_on_parse_failure === 'true',
    legacy_completion_hook_release_after_run_enabled:
      map.legacy_completion_hook_release_after_run_enabled === undefined
        ? DEFAULTS.legacy_completion_hook_release_after_run_enabled
        : map.legacy_completion_hook_release_after_run_enabled === 'true',
    legacy_completion_hook_release_after_fix_ci_enabled:
      map.legacy_completion_hook_release_after_fix_ci_enabled === undefined
        ? DEFAULTS.legacy_completion_hook_release_after_fix_ci_enabled
        : map.legacy_completion_hook_release_after_fix_ci_enabled === 'true',
    legacy_completion_hook_auto_resume_enabled:
      map.legacy_completion_hook_auto_resume_enabled === undefined
        ? DEFAULTS.legacy_completion_hook_auto_resume_enabled
        : map.legacy_completion_hook_auto_resume_enabled === 'true',
    legacy_pipeline_lock_inline_drain_enabled:
      map.legacy_pipeline_lock_inline_drain_enabled === undefined
        ? DEFAULTS.legacy_pipeline_lock_inline_drain_enabled
        : map.legacy_pipeline_lock_inline_drain_enabled === 'true',
    legacy_completion_hook_agent_drain_enabled:
      map.legacy_completion_hook_agent_drain_enabled === undefined
        ? DEFAULTS.legacy_completion_hook_agent_drain_enabled
        : map.legacy_completion_hook_agent_drain_enabled === 'true',
    plain_test_phase_enabled:
      map.plain_test_phase_enabled === undefined
        ? DEFAULTS.plain_test_phase_enabled
        : map.plain_test_phase_enabled === 'true',
    budget_block_runs_enabled: map.budget_block_runs_enabled === 'true',
    budget_block_on_weekly_pace_enabled:
      map.budget_block_on_weekly_pace_enabled === undefined
        ? DEFAULTS.budget_block_on_weekly_pace_enabled
        : map.budget_block_on_weekly_pace_enabled === 'true',
    budget_subscription_providers: normalizeBudgetSubscriptionProviders(map.budget_subscription_providers),
    budget_block_at_pct: parseIntOr(map.budget_block_at_pct, DEFAULTS.budget_block_at_pct),
    budget_warn_at_pct: parseIntOr(map.budget_warn_at_pct, DEFAULTS.budget_warn_at_pct),
    notification_on_budget_blocked: map.notification_on_budget_blocked === 'true',
    dirty_worktree_block_threshold: parseIntOr(map.dirty_worktree_block_threshold, DEFAULTS.dirty_worktree_block_threshold),
    incremental_review_enabled:
      map.incremental_review_enabled === undefined
        ? DEFAULTS.incremental_review_enabled
        : map.incremental_review_enabled === 'true',
    retrieval_enabled: map.retrieval_enabled === 'true',
    retrieval_ollama_url: map.retrieval_ollama_url ?? DEFAULTS.retrieval_ollama_url,
    retrieval_embedding_model: map.retrieval_embedding_model ?? DEFAULTS.retrieval_embedding_model,
    retrieval_context_limit: parseIntOr(map.retrieval_context_limit, DEFAULTS.retrieval_context_limit),
    retrieval_score_threshold: (() => {
      const v = parseFloat(map.retrieval_score_threshold ?? '');
      return Number.isFinite(v) ? v : DEFAULTS.retrieval_score_threshold;
    })(),
    retrieval_manage_ollama: map.retrieval_manage_ollama !== 'false',
    retrieval_reindex_interval_hours: (() => {
      const v = parseIntOr(map.retrieval_reindex_interval_hours, DEFAULTS.retrieval_reindex_interval_hours);
      return v >= 1 && v <= 168 ? v : DEFAULTS.retrieval_reindex_interval_hours;
    })(),
    outcome_classifier_enabled: map.outcome_classifier_enabled === 'true',
    outcome_classifier_model: map.outcome_classifier_model ?? DEFAULTS.outcome_classifier_model,
    project_sweep_enabled: map.project_sweep_enabled === 'true',
  };
  return config;
}

export function reloadConfig(): void {
  _cache = null;
}

function parseIntOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function parsePositiveIntOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Accept 0 as a valid value (used as an "unlimited" sentinel by callers
 *  like the review fix-loop cap). Falls back when value is missing/invalid. */
function parseNonNegativeIntOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseJsonObject(v: string | undefined): Record<string, string> {
  if (!v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function parseJsonNumberMap(v: string | undefined, fallback: Record<string, number>): Record<string, number> {
  if (!v) return fallback;
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
      if (Number.isFinite(n) && n >= 0) out[key] = n;
    }
    return { ...fallback, ...out };
  } catch {
    return fallback;
  }
}

function parseJsonStringArray(v: string | undefined): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export const VALID_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'] as const;
export type PermissionMode = (typeof VALID_PERMISSION_MODES)[number];

export function normalizePermissionMode(value: string | undefined): PermissionMode {
  return (VALID_PERMISSION_MODES as readonly string[]).includes(value ?? '')
    ? value as PermissionMode
    : DEFAULTS.permission_mode as PermissionMode;
}

/**
 * Resolve the Claude model to use for a specific pipeline step. Returns the
 * user-configured override (Settings → Pipeline) when set; otherwise falls
 * back to the per-step default. `review` and `fix` default to the workspace
 * default_model (the user's general-purpose model); `dod` and `commit`
 * default to fast because they're cheap, well-scoped tasks where stronger
 * models would be wasteful.
 */
export type PipelineStepKind = 'review' | 'fix' | 'dod' | 'commit';

export function getPipelineModel(step: PipelineStepKind): string {
  const cfg = getSettings();
  const override = (
    step === 'review' ? cfg.pipeline_model_review :
    step === 'fix'    ? cfg.pipeline_model_fix    :
    step === 'dod'    ? cfg.pipeline_model_dod    :
                        cfg.pipeline_model_commit
  );
  if (override) return normalizeModelInput(override);
  if (step === 'dod' || step === 'commit') return 'fast';
  return normalizeModelInput(cfg.default_model);
}

/** Returns the --permission-mode flag string for the Claude CLI. */
export function getPermissionModeFlag(): string {
  const { permission_mode } = getSettings();
  const mode = normalizePermissionMode(permission_mode);
  return `--permission-mode ${mode}`;
}

/** Prepend the base prompt (if configured) to a user/task prompt. */
export function withBasePrompt(
  prompt: string,
  options: { projectPath?: string; provider?: string | null } = {},
): string {
  const settings = getSettings();
  const { base_prompt } = settings;
  const parts: string[] = [];
  if (base_prompt) parts.push(base_prompt);

  const provider = options.provider && isCliProvider(options.provider)
    ? options.provider
    : getActiveCliProvider(settings);

  if (options.projectPath && PROJECT_MEMORY_PROVIDERS.has(provider)) {
    const memoryPath = join(options.projectPath, 'CLAUDE.md');
    try {
      const memory = readFileSync(/*turbopackIgnore: true*/ memoryPath, 'utf-8').trim();
      if (memory) {
        parts.push(`Project instructions from CLAUDE.md:\n\n${memory}`);
      }
    } catch {
      // Missing/unreadable project memory should not block a run.
    }
  }

  if (parts.length === 0) return prompt;
  return `${parts.join('\n\n---\n\n')}\n\n---\n\n${prompt}`;
}
