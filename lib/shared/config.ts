import { db, schema } from '@/lib/db';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
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
  cli_default_model_claude: string;
  cli_default_model_codex: string;
  cli_default_model_gemini: string;
  cli_default_model_lmstudio: string;
  log_dir: string;
  frequency: string;
  daytime: boolean;
  weekends: boolean;
  launchagent_prefix: string;
  base_prompt: string;
  default_model: string;
  permission_mode: string;
  commit_style: string;
  review_verdict_rules: string;
  jobs_paused: boolean;
  review_fix_max_iterations: number;
  log_retention_count: number;
  log_retention_days: number;
  job_row_retention_days: number;
  notification_webhook_url: string;
  notification_webhook_secret: string;
  notification_on_release_success: boolean;
  notification_on_release_fail: boolean;
  notification_on_release_aborted: boolean;
  notification_on_fix_loop_exhausted: boolean;
  notification_on_review_do_not_ship: boolean;
  notification_on_agent_run_fail: boolean;
  pipeline_model_review: string;
  pipeline_model_fix: string;
  pipeline_model_dod: string;
  pipeline_model_commit: string;
  review_retry_on_parse_failure: boolean;
  budget_block_runs_enabled: boolean;
  budget_subscription_providers: BudgetSubscriptionProvider[];
  budget_block_at_pct: number;
  budget_warn_at_pct: number;
  notification_on_budget_blocked: boolean;
  dirty_worktree_block_threshold: number;
  incremental_review_enabled: boolean;
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
  cli_default_model_claude: 'normal',
  cli_default_model_codex: 'normal',
  cli_default_model_gemini: 'normal',
  cli_default_model_lmstudio: 'normal',
  log_dir: './data/logs',
  frequency: '1h',
  daytime: false,
  weekends: false,
  launchagent_prefix: 'com.tamtam',
  base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
  default_model: 'fast',
  permission_mode: 'acceptEdits',
  commit_style: 'Use conventional commits. One line only, present tense, ≤50 chars, no trailing period. Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert.',
  review_verdict_rules: `Pragmatic verdict rules — the release pipeline needs to actually reach LGTM sometimes:
- LGTM when the change is safe to ship. Cosmetic nits, dead imports, orphan state, style inconsistencies, or "consider…" / "nice-to-have" suggestions do NOT block LGTM — mention them as non-blocking notes if you must, but still say LGTM. The bar is: "would you merge this yourself?"
- NEEDS ATTENTION when there is at least one genuine correctness or UX issue that you'd want fixed before merge, but no risk of breakage. Missing error handling on a path that matters, wrong business logic, broken types, a test that masks behavior — that's NEEDS ATTENTION.
- DO NOT SHIP for real risk: data loss, security regression, guaranteed production breakage.
- Prefer LGTM over NEEDS ATTENTION when in doubt. Do not list every stylistic opinion. Aim for fewer than 3 findings — if you have more, the review has drifted into nitpicking.
- Keep LGTM responses short: one sentence confirmation is enough.`,
  jobs_paused: false,
  review_fix_max_iterations: 3,
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
  // Empty string = use the per-step sensible default (review/fix → workspace
  // default_model; dod/commit → fast since they're cheap classification tasks).
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
  dirty_worktree_block_threshold: 20,
  incremental_review_enabled: true,
};

let _cache: { config: TamTamConfig; time: number } | null = null;
const CACHE_TTL = 5; // seconds

const VALID_CLAUDE_PROVIDERS = new Set(['claude', 'gemini', 'lmstudio', 'codex', 'custom']);
const PROJECT_MEMORY_PROVIDERS = new Set(['gemini', 'lmstudio', 'codex']);

function shimPath(name: string): string {
  return join(process.env.TAMTAM_ROOT || process.cwd(), 'scripts', name);
}

function isShimPath(bin: string | undefined): boolean {
  if (!bin) return false;
  return /scripts\/(claude|gemini|lmstudio|codex)-shim\.js$/.test(bin);
}

function inferClaudeProvider(claudeBin: string | undefined): string {
  if (!claudeBin) return DEFAULTS.claude_provider;
  if (claudeBin.endsWith('/scripts/gemini-shim.js') || claudeBin.endsWith('scripts/gemini-shim.js')) return 'gemini';
  if (claudeBin.endsWith('/scripts/lmstudio-shim.js') || claudeBin.endsWith('scripts/lmstudio-shim.js')) return 'lmstudio';
  if (claudeBin.endsWith('/scripts/codex-shim.js') || claudeBin.endsWith('scripts/codex-shim.js')) return 'codex';
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
  if (legacyProvider === 'codex' || legacyProvider === 'gemini' || legacyProvider === 'lmstudio') {
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

export function getSettings(): TamTamConfig {
  const now = Date.now() / 1000;
  if (_cache && now - _cache.time < CACHE_TTL) return _cache.config;

  const rows = db.select().from(schema.settings).all();
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;

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
    cli_default_model_claude: normalizeModelInput(map.cli_default_model_claude, 'normal'),
    cli_default_model_codex: normalizeModelInput(map.cli_default_model_codex, 'normal'),
    cli_default_model_gemini: normalizeModelInput(map.cli_default_model_gemini, 'normal'),
    cli_default_model_lmstudio: normalizeModelInput(map.cli_default_model_lmstudio, 'normal'),
    log_dir: map.log_dir ?? DEFAULTS.log_dir,
    frequency: map.frequency ?? DEFAULTS.frequency,
    daytime: map.daytime === 'true',
    weekends: map.weekends === 'on',
    launchagent_prefix: map.launchagent_prefix ?? DEFAULTS.launchagent_prefix,
    base_prompt: map.base_prompt ?? DEFAULTS.base_prompt,
    default_model: normalizeModelInput(map.default_model, DEFAULTS.default_model as 'fast'),
    permission_mode: map.permission_mode ?? DEFAULTS.permission_mode,
    commit_style: map.commit_style ?? DEFAULTS.commit_style,
    review_verdict_rules: map.review_verdict_rules ?? DEFAULTS.review_verdict_rules,
    jobs_paused: map.jobs_paused === 'true',
    review_fix_max_iterations: parsePositiveIntOr(map.review_fix_max_iterations, DEFAULTS.review_fix_max_iterations),
    log_retention_count: parseIntOr(map.log_retention_count, DEFAULTS.log_retention_count),
    log_retention_days: parseIntOr(map.log_retention_days, DEFAULTS.log_retention_days),
    job_row_retention_days: parseIntOr(map.job_row_retention_days, DEFAULTS.job_row_retention_days),
    notification_webhook_url: map.notification_webhook_url ?? DEFAULTS.notification_webhook_url,
    notification_webhook_secret: map.notification_webhook_secret ?? DEFAULTS.notification_webhook_secret,
    notification_on_release_success: map.notification_on_release_success === 'true',
    notification_on_release_fail: map.notification_on_release_fail === 'true',
    notification_on_release_aborted: map.notification_on_release_aborted === 'true',
    notification_on_fix_loop_exhausted: map.notification_on_fix_loop_exhausted === 'true',
    notification_on_review_do_not_ship: map.notification_on_review_do_not_ship === 'true',
    notification_on_agent_run_fail: map.notification_on_agent_run_fail === 'true',
    pipeline_model_review: resolveModelAlias(map.pipeline_model_review),
    pipeline_model_fix: resolveModelAlias(map.pipeline_model_fix),
    pipeline_model_dod: resolveModelAlias(map.pipeline_model_dod),
    pipeline_model_commit: resolveModelAlias(map.pipeline_model_commit),
    review_retry_on_parse_failure:
      map.review_retry_on_parse_failure === undefined
        ? DEFAULTS.review_retry_on_parse_failure
        : map.review_retry_on_parse_failure === 'true',
    budget_block_runs_enabled: map.budget_block_runs_enabled === 'true',
    budget_subscription_providers: normalizeBudgetSubscriptionProviders(map.budget_subscription_providers),
    budget_block_at_pct: parseIntOr(map.budget_block_at_pct, DEFAULTS.budget_block_at_pct),
    budget_warn_at_pct: parseIntOr(map.budget_warn_at_pct, DEFAULTS.budget_warn_at_pct),
    notification_on_budget_blocked: map.notification_on_budget_blocked === 'true',
    dirty_worktree_block_threshold: parseIntOr(map.dirty_worktree_block_threshold, DEFAULTS.dirty_worktree_block_threshold),
    incremental_review_enabled:
      map.incremental_review_enabled === undefined
        ? DEFAULTS.incremental_review_enabled
        : map.incremental_review_enabled === 'true',
  };

  if (config.lmstudio_model) {
    process.env.LMSTUDIO_MODEL = config.lmstudio_model;
  } else {
    delete process.env.LMSTUDIO_MODEL;
  }

  _cache = { config, time: now };
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

function parseJsonObject(v: string | undefined): Record<string, string> {
  if (!v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
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
    if (existsSync(memoryPath)) {
      try {
        const memory = readFileSync(memoryPath, 'utf-8').trim();
        if (memory) {
          parts.push(`Project instructions from CLAUDE.md:\n\n${memory}`);
        }
      } catch {
        // Missing/unreadable project memory should not block a run.
      }
    }
  }

  if (parts.length === 0) return prompt;
  return `${parts.join('\n\n---\n\n')}\n\n---\n\n${prompt}`;
}
