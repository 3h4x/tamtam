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
}

const DEFAULTS: TamTamConfig = {
  workspace_path: '',
  github_owner: '',
  claude_bin: '~/.local/bin/claude',
  log_dir: '~/logs',
  frequency: '1h',
  daytime: false,
  weekends: false,
  launchagent_prefix: 'com.tamtam',
  base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
  default_model: 'haiku',
  permission_mode: 'bypassPermissions',
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
  };

  _cache = { config, time: now };
  return config;
}

export function reloadConfig(): void {
  _cache = null;
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
