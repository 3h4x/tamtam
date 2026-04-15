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
  };

  _cache = { config, time: now };
  return config;
}

export function reloadConfig(): void {
  _cache = null;
}
