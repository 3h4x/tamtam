import { db, schema } from './db';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

/**
 * Read all settings from the DB and return as a config object.
 * All settings are stored in the DB settings table.
 */

export interface TamTamConfig {
  workspace_path: string;
  github_owner: string;
  claude_provider: string;
  claude_bin: string;
  lmstudio_model: string;
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
  fix_ci_max_retries: number;
  fix_ci_retry_window_seconds: number;
  fix_ci_fast_crash_ms: number;
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
}

const DEFAULTS: TamTamConfig = {
  workspace_path: '',
  github_owner: '',
  claude_provider: 'claude',
  claude_bin: '~/.local/bin/claude',
  lmstudio_model: '',
  log_dir: './data/logs',
  frequency: '1h',
  daytime: false,
  weekends: false,
  launchagent_prefix: 'com.tamtam',
  base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
  default_model: 'haiku',
  permission_mode: 'bypassPermissions',
  commit_style: 'Use conventional commits. One line only, present tense, ≤50 chars, no trailing period. Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert.',
  review_verdict_rules: `Pragmatic verdict rules — the release pipeline needs to actually reach LGTM sometimes:
- LGTM when the change is safe to ship. Cosmetic nits, dead imports, orphan state, style inconsistencies, or "consider…" / "nice-to-have" suggestions do NOT block LGTM — mention them as non-blocking notes if you must, but still say LGTM. The bar is: "would you merge this yourself?"
- NEEDS ATTENTION when there is at least one genuine correctness or UX issue that you'd want fixed before merge, but no risk of breakage. Missing error handling on a path that matters, wrong business logic, broken types, a test that masks behavior — that's NEEDS ATTENTION.
- DO NOT SHIP for real risk: data loss, security regression, guaranteed production breakage.
- Prefer LGTM over NEEDS ATTENTION when in doubt. Do not list every stylistic opinion. Aim for fewer than 3 findings — if you have more, the review has drifted into nitpicking.
- Keep LGTM responses short: one sentence confirmation is enough.`,
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
  // Empty string = use the per-step sensible default (review/fix → workspace
  // default_model; dod/commit → haiku since they're cheap classification tasks).
  pipeline_model_review: '',
  pipeline_model_fix: '',
  pipeline_model_dod: '',
  pipeline_model_commit: '',
};

let _cache: { config: TamTamConfig; time: number } | null = null;
const CACHE_TTL = 5; // seconds

const VALID_CLAUDE_PROVIDERS = new Set(['claude', 'gemini', 'lmstudio', 'custom']);
const PROJECT_MEMORY_PROVIDERS = new Set(['gemini', 'lmstudio']);

function shimPath(name: string): string {
  return join(process.env.TAMTAM_ROOT || process.cwd(), 'scripts', name);
}

function isShimPath(bin: string | undefined): boolean {
  if (!bin) return false;
  return /scripts\/(gemini|lmstudio)-shim\.js$/.test(bin);
}

function inferClaudeProvider(claudeBin: string | undefined): string {
  if (!claudeBin) return DEFAULTS.claude_provider;
  if (claudeBin.endsWith('/scripts/gemini-shim.js') || claudeBin.endsWith('scripts/gemini-shim.js')) return 'gemini';
  if (claudeBin.endsWith('/scripts/lmstudio-shim.js') || claudeBin.endsWith('scripts/lmstudio-shim.js')) return 'lmstudio';
  if (claudeBin === DEFAULTS.claude_bin || claudeBin.endsWith('/claude') || claudeBin === 'claude') return 'claude';
  return 'custom';
}

function resolveClaudeBin(provider: string, storedBin: string | undefined): string {
  if (provider === 'gemini') return shimPath('gemini-shim.js');
  if (provider === 'lmstudio') return shimPath('lmstudio-shim.js');
  // For claude/custom providers, ignore stored shim paths left over from a prior
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
    claude_provider: provider,
    claude_bin: resolveClaudeBin(provider, map.claude_bin),
    lmstudio_model: map.lmstudio_model ?? DEFAULTS.lmstudio_model,
    log_dir: map.log_dir ?? DEFAULTS.log_dir,
    frequency: map.frequency ?? DEFAULTS.frequency,
    daytime: map.daytime === 'true',
    weekends: map.weekends === 'on',
    launchagent_prefix: map.launchagent_prefix ?? DEFAULTS.launchagent_prefix,
    base_prompt: map.base_prompt ?? DEFAULTS.base_prompt,
    default_model: map.default_model ?? DEFAULTS.default_model,
    permission_mode: map.permission_mode ?? DEFAULTS.permission_mode,
    commit_style: map.commit_style ?? DEFAULTS.commit_style,
    review_verdict_rules: map.review_verdict_rules ?? DEFAULTS.review_verdict_rules,
    jobs_paused: map.jobs_paused === 'true',
    fix_ci_max_retries: parseIntOr(map.fix_ci_max_retries, DEFAULTS.fix_ci_max_retries),
    fix_ci_retry_window_seconds: parseIntOr(map.fix_ci_retry_window_seconds, DEFAULTS.fix_ci_retry_window_seconds),
    fix_ci_fast_crash_ms: parseIntOr(map.fix_ci_fast_crash_ms, DEFAULTS.fix_ci_fast_crash_ms),
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
    pipeline_model_review: map.pipeline_model_review ?? DEFAULTS.pipeline_model_review,
    pipeline_model_fix: map.pipeline_model_fix ?? DEFAULTS.pipeline_model_fix,
    pipeline_model_dod: map.pipeline_model_dod ?? DEFAULTS.pipeline_model_dod,
    pipeline_model_commit: map.pipeline_model_commit ?? DEFAULTS.pipeline_model_commit,
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

const VALID_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'] as const;

/**
 * Resolve the Claude model to use for a specific pipeline step. Returns the
 * user-configured override (Settings → Pipeline) when set; otherwise falls
 * back to the per-step default. `review` and `fix` default to the workspace
 * default_model (the user's general-purpose model); `dod` and `commit`
 * default to haiku because they're cheap, well-scoped tasks where stronger
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
  if (override) return override;
  if (step === 'dod' || step === 'commit') return 'haiku';
  return cfg.default_model;
}

/** Returns the --permission-mode flag string for the Claude CLI. */
export function getPermissionModeFlag(): string {
  const { permission_mode } = getSettings();
  const mode = (VALID_PERMISSION_MODES as readonly string[]).includes(permission_mode) ? permission_mode : 'bypassPermissions';
  return `--permission-mode ${mode}`;
}

/** Prepend the base prompt (if configured) to a user/task prompt. */
export function withBasePrompt(prompt: string, options: { projectPath?: string } = {}): string {
  const { base_prompt, claude_provider } = getSettings();
  const parts: string[] = [];
  if (base_prompt) parts.push(base_prompt);

  if (options.projectPath && PROJECT_MEMORY_PROVIDERS.has(claude_provider)) {
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
