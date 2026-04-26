import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface FileProjectConfig {
  test_command?: string;
  pr_workflow_enabled?: boolean;
  auto_push_enabled?: boolean;
  auto_commit_enabled?: boolean;
  auto_pr_merge_enabled?: boolean;
  tests_disabled?: boolean;
  review_disabled?: boolean;
  issue_auto_branch?: boolean;
}

const BOOL_KEYS = new Set([
  'pr_workflow_enabled',
  'auto_push_enabled',
  'auto_commit_enabled',
  'auto_pr_merge_enabled',
  'tests_disabled',
  'review_disabled',
  'issue_auto_branch',
]);

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
      const key = line.slice(0, colonIdx).trim();
      const rawVal = line.slice(colonIdx + 1).trim();
      if (!rawVal) continue;
      const value = parseValue(rawVal);

      if (key === 'test_command' && typeof value === 'string') {
        config.test_command = value;
      } else if (BOOL_KEYS.has(key) && typeof value === 'boolean') {
        (config as Record<string, unknown>)[key] = value;
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  } catch {
    return null;
  }
}
