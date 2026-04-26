import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

export interface FileProjectConfig {
  // pipeline
  test_command?: string;
  pr_workflow_enabled?: boolean;
  auto_commit_enabled?: boolean;
  auto_push_enabled?: boolean;
  auto_pr_merge_enabled?: boolean;
  release_after_run?: boolean;
  // schedule
  test_cron_enabled?: boolean;
  test_cron_schedule?: string;
  // gates
  tests_disabled?: boolean;
  review_disabled?: boolean;
  issue_auto_branch?: boolean;
  // security
  safe_users?: string[];
}

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
  {
    label: 'security',
    keys: ['safe_users'],
  },
];

const ALL_KEYS = new Set<string>(GROUPS.flatMap(g => g.keys as string[]));

export function loadFileConfig(projectPath: string): FileProjectConfig | null {
  const configPath = join(projectPath, '.tamtam', 'config.yml');
  if (!existsSync(configPath)) return null;

  try {
    const raw = yamlParse(readFileSync(configPath, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const obj = raw as Record<string, unknown>;

    // Flatten grouped sections: { pipeline: { test_command: ... } } → { test_command: ... }
    const flat: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        Object.assign(flat, val as Record<string, unknown>);
      } else {
        flat[key] = val;
      }
    }

    const config: FileProjectConfig = {};

    if (typeof flat.test_command === 'string') config.test_command = flat.test_command;
    if (typeof flat.test_cron_schedule === 'string') config.test_cron_schedule = flat.test_cron_schedule;

    const boolKeys = [
      'pr_workflow_enabled', 'auto_commit_enabled', 'auto_push_enabled',
      'auto_pr_merge_enabled', 'release_after_run', 'test_cron_enabled',
      'tests_disabled', 'review_disabled', 'issue_auto_branch',
    ] as const;
    for (const k of boolKeys) {
      if (typeof flat[k] === 'boolean') config[k] = flat[k] as boolean;
    }

    if (Array.isArray(flat.safe_users) && flat.safe_users.every(u => typeof u === 'string')) {
      config.safe_users = flat.safe_users as string[];
    }

    return Object.keys(config).length > 0 ? config : null;
  } catch {
    return null;
  }
}

/**
 * Write (merge) config values into .tamtam/config.yml.
 * Creates the file and directory if they don't exist.
 * Keys set to null/undefined are removed; existing unrelated keys are preserved.
 */
export function writeFileConfig(
  projectPath: string,
  updates: Partial<Record<keyof FileProjectConfig, string | boolean | string[] | null>>
): void {
  const tamtamDir = join(projectPath, '.tamtam');
  const configPath = join(tamtamDir, 'config.yml');

  mkdirSync(tamtamDir, { recursive: true });

  // Read the raw YAML document to preserve unrecognized keys that TamTam doesn't know about.
  // loadFileConfig only returns recognized keys, so we must source unknown keys from the raw file.
  let rawDoc: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = yamlParse(readFileSync(configPath, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawDoc = parsed as Record<string, unknown>;
      }
    } catch { /* ignore parse errors — we'll overwrite with clean content */ }
  }

  // Flatten recognized keys from the raw doc for mutation, keyed by their leaf name.
  const current: Record<string, unknown> = { ...(loadFileConfig(projectPath) ?? {}) };

  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      delete current[key];
    } else {
      current[key] = value;
    }
  }

  // Build grouped document object from recognized keys.
  const doc: Record<string, Record<string, unknown>> = {};
  for (const group of GROUPS) {
    const section: Record<string, unknown> = {};
    for (const key of group.keys as string[]) {
      if (current[key] !== undefined) section[key] = current[key];
    }
    if (Object.keys(section).length > 0) doc[group.label] = section;
  }

  // Collect unknown top-level keys from the raw document (section objects that aren't TamTam
  // groups, or flat keys that aren't in any group) and preserve them verbatim.
  const knownGroupLabels = new Set(GROUPS.map(g => g.label));
  const docWithUnknown: Record<string, unknown> = { ...doc };
  for (const [k, v] of Object.entries(rawDoc)) {
    if (!knownGroupLabels.has(k) && !ALL_KEYS.has(k)) {
      docWithUnknown[k] = v;
    }
  }

  const header = '# TamTam project configuration — committed to version control\n# See .tamtam/agents/ for agent definitions\n';
  const body = Object.keys(docWithUnknown).length > 0 ? yamlStringify(docWithUnknown) : '';
  writeFileSync(configPath, header + (body ? '\n' + body : '\n'));
}
