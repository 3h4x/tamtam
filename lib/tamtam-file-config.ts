import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface FileProjectConfig {
  // Pipeline
  test_command?: string;
  pr_workflow_enabled?: boolean;
  auto_commit_enabled?: boolean;
  auto_push_enabled?: boolean;
  auto_pr_merge_enabled?: boolean;
  release_after_run?: boolean;
  // Cron
  test_cron_enabled?: boolean;
  test_cron_schedule?: string;
  // Gates
  tests_disabled?: boolean;
  review_disabled?: boolean;
  issue_auto_branch?: boolean;
}

// Ordered list of all supported keys — determines write order in YAML
const ALL_KEYS: (keyof FileProjectConfig)[] = [
  'test_command',
  'pr_workflow_enabled',
  'auto_commit_enabled',
  'auto_push_enabled',
  'auto_pr_merge_enabled',
  'release_after_run',
  'test_cron_enabled',
  'test_cron_schedule',
  'tests_disabled',
  'review_disabled',
  'issue_auto_branch',
];

const BOOL_KEYS = new Set<keyof FileProjectConfig>([
  'pr_workflow_enabled',
  'auto_push_enabled',
  'auto_commit_enabled',
  'auto_pr_merge_enabled',
  'release_after_run',
  'test_cron_enabled',
  'tests_disabled',
  'review_disabled',
  'issue_auto_branch',
]);

const STRING_KEYS = new Set<keyof FileProjectConfig>(['test_command', 'test_cron_schedule']);

function parseValue(raw: string): string | boolean {
  const v = raw.trim().replace(/^["']|["']$/g, '');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

export function loadFileConfig(projectPath: string): FileProjectConfig | null {
  const configPath = join(projectPath, '.tamtam', 'config.yml');
  if (!existsSync(configPath)) return null;

  try {
    const config: FileProjectConfig = {};

    for (const raw of readFileSync(configPath, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0) continue;
      const key = line.slice(0, colonIdx).trim() as keyof FileProjectConfig;
      const rawVal = line.slice(colonIdx + 1).trim();
      if (!rawVal) continue;
      const value = parseValue(rawVal);

      if (STRING_KEYS.has(key) && typeof value === 'string') {
        (config as Record<string, unknown>)[key] = value;
      } else if (BOOL_KEYS.has(key) && typeof value === 'boolean') {
        (config as Record<string, unknown>)[key] = value;
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  } catch {
    return null;
  }
}

/**
 * Write (merge) config values into .tamtam/config.yml.
 * Creates the file and directory if they don't exist.
 * Keys set to null/undefined are removed from the file.
 */
export function writeFileConfig(
  projectPath: string,
  updates: Partial<Record<keyof FileProjectConfig, string | boolean | null>>
): void {
  const tamtamDir = join(projectPath, '.tamtam');
  const configPath = join(tamtamDir, 'config.yml');

  mkdirSync(tamtamDir, { recursive: true });

  // Load existing config as a raw map so we preserve unknown keys
  const current: Map<string, string> = new Map();
  if (existsSync(configPath)) {
    for (const raw of readFileSync(configPath, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        current.set(line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim());
      }
    }
  }

  // Apply updates
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      current.delete(key);
    } else {
      current.set(key, String(value));
    }
  }

  // Serialize in canonical key order, unknown keys appended at end
  const knownSet = new Set(ALL_KEYS as string[]);
  const lines: string[] = [
    '# TamTam project configuration — committed to version control',
    '# See .tamtam/agents/ for agent definitions',
    '',
  ];
  for (const key of ALL_KEYS) {
    if (current.has(key)) {
      lines.push(`${key}: ${current.get(key)}`);
    }
  }
  for (const [key, val] of current) {
    if (!knownSet.has(key)) lines.push(`${key}: ${val}`);
  }

  writeFileSync(configPath, lines.join('\n') + '\n');
}
