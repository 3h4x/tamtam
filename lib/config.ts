import { db, schema } from './db';

/**
 * Read all settings from the DB and return as a config object.
 * All settings are stored in the DB settings table.
 */

export interface TamTamConfig {
  workspace_path: string;
  github_owner: string;
  claude_bin: string;
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
  fix_ci_max_retries: number;
  fix_ci_retry_window_seconds: number;
  fix_ci_fast_crash_ms: number;
}

const DEFAULTS: TamTamConfig = {
  workspace_path: '',
  github_owner: '',
  claude_bin: '~/.local/bin/claude',
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
  fix_ci_max_retries: 2,
  fix_ci_retry_window_seconds: 120,
  fix_ci_fast_crash_ms: 5000,
};

let _cache: { config: TamTamConfig; time: number } | null = null;
const CACHE_TTL = 5; // seconds

export function getSettings(): TamTamConfig {
  const now = Date.now() / 1000;
  if (_cache && now - _cache.time < CACHE_TTL) return _cache.config;

  const rows = db.select().from(schema.settings).all();
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;

  const config: TamTamConfig = {
    workspace_path: map.workspace_path ?? DEFAULTS.workspace_path,
    github_owner: map.github_owner ?? DEFAULTS.github_owner,
    claude_bin: map.claude_bin ?? DEFAULTS.claude_bin,
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
    fix_ci_max_retries: parseIntOr(map.fix_ci_max_retries, DEFAULTS.fix_ci_max_retries),
    fix_ci_retry_window_seconds: parseIntOr(map.fix_ci_retry_window_seconds, DEFAULTS.fix_ci_retry_window_seconds),
    fix_ci_fast_crash_ms: parseIntOr(map.fix_ci_fast_crash_ms, DEFAULTS.fix_ci_fast_crash_ms),
  };

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

/** Returns the --permission-mode flag string for the Claude CLI. */
export function getPermissionModeFlag(): string {
  const { permission_mode } = getSettings();
  const mode = VALID_PERMISSION_MODES.includes(permission_mode as any) ? permission_mode : 'bypassPermissions';
  return `--permission-mode ${mode}`;
}

/** Prepend the base prompt (if configured) to a user/task prompt. */
export function withBasePrompt(prompt: string): string {
  const { base_prompt } = getSettings();
  if (!base_prompt) return prompt;
  return `${base_prompt}\n\n---\n\n${prompt}`;
}
