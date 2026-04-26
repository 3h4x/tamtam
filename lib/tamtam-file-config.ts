import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface FileProjectConfig {
  test_command?: string;
  pr_workflow_enabled?: boolean;
  auto_commit_enabled?: boolean;
  auto_push_enabled?: boolean;
  auto_pr_merge_enabled?: boolean;
  release_after_run?: boolean;
  test_cron_enabled?: boolean;
  test_cron_schedule?: string;
  tests_disabled?: boolean;
  review_disabled?: boolean;
  issue_auto_branch?: boolean;
}

// Groups define both the YAML section order and which keys belong to each section.
const GROUPS: { label: string; keys: (keyof FileProjectConfig)[] }[] = [
  {
    label: 'pipeline',
    keys: ['test_command', 'pr_workflow_enabled', 'auto_commit_enabled', 'auto_push_enabled', 'auto_pr_merge_enabled', 'release_after_run'],
  },
  {
    label: 'schedule',
    keys: ['test_cron_enabled', 'test_cron_schedule'],
  },
  {
    label: 'gates',
    keys: ['tests_disabled', 'review_disabled', 'issue_auto_branch'],
  },
];

const ALL_KEYS = GROUPS.flatMap(g => g.keys);

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
      // Accept both flat keys and indented keys under a group header.
      // Group header lines (e.g. "pipeline:") have no value — skip them.
      const line = raw.trimEnd();
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) continue;
      const key = trimmed.slice(0, colonIdx).trim() as keyof FileProjectConfig;
      const rawVal = trimmed.slice(colonIdx + 1).trim();
      if (!rawVal) continue; // group header or empty value
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
 * Write (merge) config values into .tamtam/config.yml using grouped sections.
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

  // Load existing values — read both flat and grouped formats
  const current: Map<string, string> = new Map();
  if (existsSync(configPath)) {
    for (const raw of readFileSync(configPath, 'utf-8').split('\n')) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const val = trimmed.slice(colonIdx + 1).trim();
        if (val) current.set(key, val); // skip group headers (no value)
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

  // Serialize with grouped sections
  const knownSet = new Set(ALL_KEYS as string[]);
  const lines: string[] = [
    '# TamTam project configuration — committed to version control',
    '# See .tamtam/agents/ for agent definitions',
  ];

  for (const group of GROUPS) {
    const groupLines = group.keys
      .filter(k => current.has(k))
      .map(k => `  ${k}: ${current.get(k)}`);
    if (groupLines.length > 0) {
      lines.push('', `${group.label}:`);
      lines.push(...groupLines);
    }
  }

  // Unknown keys appended flat at the end
  const unknownLines = [...current.entries()]
    .filter(([k]) => !knownSet.has(k))
    .map(([k, v]) => `${k}: ${v}`);
  if (unknownLines.length > 0) {
    lines.push('', '# custom');
    lines.push(...unknownLines);
  }

  writeFileSync(configPath, lines.join('\n') + '\n');
}
