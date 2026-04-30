import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { getBranchContext, gitShowSync } from '@/lib/git/git-branch';

/**
 * Legacy workflow flags that used to live in `.tamtam/config.yml` but are
 * now DB-only. Kept here so the one-shot startup migration can find them.
 */
const LEGACY_WORKFLOW_KEYS = [
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
] as const;

export type LegacyWorkflowKey = typeof LEGACY_WORKFLOW_KEYS[number];

/**
 * Reads legacy workflow flags from a project's `.tamtam/config.yml` working tree
 * (regardless of branch — this is the local file the developer is upgrading from).
 * Returns an empty object when the file is missing or contains no legacy keys.
 *
 * Used once at startup to seed the DB before those keys silently stop being honored.
 */
export function readLegacyWorkflowFlags(
  projectPath: string
): Partial<Record<LegacyWorkflowKey, boolean | string>> {
  const configPath = join(projectPath, '.tamtam', 'config.yml');
  if (!existsSync(configPath)) return {};
  let parsed: unknown;
  try {
    parsed = yamlParse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;

  // Collect nested-section values first, then let top-level keys win — this
  // way an explicit top-level `auto_push_enabled: false` overrides a stale
  // `pipeline.auto_push_enabled: true` instead of being silently shadowed.
  const flat: Record<string, unknown> = {};
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(flat, val as Record<string, unknown>);
    }
  }
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
      flat[key] = val;
    }
  }

  const out: Partial<Record<LegacyWorkflowKey, boolean | string>> = {};
  for (const key of LEGACY_WORKFLOW_KEYS) {
    const v = flat[key];
    if (key === 'test_cron_schedule') {
      if (typeof v === 'string') out[key] = v;
    } else if (typeof v === 'boolean') {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Custom action entry as committed in `.tamtam/config.yml`. Mirrors the
 * `CustomAction` shape used by the action API route.
 */
export interface FileCustomAction {
  name: string;
  command: string;
  color?: string;
}

/**
 * What `.tamtam/config.yml` is allowed to set.
 *
 * The file is the *team contract* — committed to version control and shared by
 * everyone working on the repo. It captures things that should be the same
 * for every developer:
 *   • test_command   — what command runs the project's tests
 *   • custom_actions — buttons that should exist on the project page
 *   • safe_users     — GitHub logins whose PR comments are not wrapped as untrusted
 *
 * Workflow flags (auto-push, auto-commit, PR mode, gates, test cron) intentionally
 * live in the DB only — each developer can opt in to automation without
 * forcing it on teammates. Older `.tamtam/config.yml` files may still contain
 * those keys; we ignore them on read and never write them back.
 */
export interface FileProjectConfig {
  test_command?: string;
  custom_actions?: FileCustomAction[];
  safe_users?: string[];
}

const GROUPS: { label: string; keys: (keyof FileProjectConfig)[] }[] = [
  { label: 'pipeline', keys: ['test_command'] },
  { label: 'actions', keys: ['custom_actions'] },
  { label: 'security', keys: ['safe_users'] },
];

const ALL_KEYS = new Set<string>(GROUPS.flatMap(g => g.keys as string[]));

function parseCustomActions(raw: unknown): FileCustomAction[] | null {
  if (!Array.isArray(raw)) return null;
  const out: FileCustomAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== 'string' || typeof o.command !== 'string') continue;
    const action: FileCustomAction = { name: o.name, command: o.command };
    if (typeof o.color === 'string') action.color = o.color;
    out.push(action);
  }
  return out;
}

function parseConfigYaml(raw: string): FileProjectConfig | null {
  try {
    const parsed = yamlParse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const obj = parsed as Record<string, unknown>;

    // Flatten grouped sections: { pipeline: { test_command: ... } } → { test_command: ... }
    // Arrays are kept as-is — custom_actions is an array, not a section.
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

    // An explicitly-empty array means "no actions" and must be respected
    // (so committing an empty list clears teammates' DB-stored actions on pull).
    const actions = parseCustomActions(flat.custom_actions);
    if (actions !== null) config.custom_actions = actions;

    if (Array.isArray(flat.safe_users) && flat.safe_users.every(u => typeof u === 'string')) {
      config.safe_users = flat.safe_users as string[];
    }

    return Object.keys(config).length > 0 ? config : null;
  } catch {
    return null;
  }
}

export function loadFileConfig(projectPath: string): FileProjectConfig | null {
  const ctx = getBranchContext(projectPath);

  if (!ctx.isDefaultBranch) {
    // On a feature/PR branch: read from origin/<defaultBranch> to prevent privilege escalation
    // from untrusted branches adding malicious .tamtam/ config.
    const content = gitShowSync(projectPath, `origin/${ctx.defaultBranch}`, '.tamtam/config.yml');
    if (content === null) return null;
    return parseConfigYaml(content);
  }

  // On the default branch: read from the working tree as before.
  const configPath = join(projectPath, '.tamtam', 'config.yml');
  if (!existsSync(configPath)) return null;

  try {
    return parseConfigYaml(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Returns branch context for a project, for use in API responses / UI banners.
 * When isDefaultBranch is false, config was read from origin/<defaultBranch>.
 */
export { getBranchContext } from '@/lib/git/git-branch';

/**
 * Write (merge) config values into .tamtam/config.yml.
 * Always writes to the working tree so the change is committed on the current branch.
 * Creates the file and directory if they don't exist.
 * Keys set to null/undefined are removed; existing unrelated keys are preserved.
 */
export function writeFileConfig(
  projectPath: string,
  updates: Partial<Record<keyof FileProjectConfig, string | string[] | FileCustomAction[] | null>>
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
  const ctx = getBranchContext(projectPath);
  let baseConfig: FileProjectConfig;
  if (ctx.isDefaultBranch) {
    baseConfig = loadFileConfig(projectPath) ?? {};
  } else {
    // For writes on a feature branch, start from the working-tree file (if present) so we don't
    // lose local edits, even though reads come from the default branch.
    if (existsSync(configPath)) {
      try {
        baseConfig = parseConfigYaml(readFileSync(configPath, 'utf-8')) ?? {};
      } catch {
        baseConfig = {};
      }
    } else {
      baseConfig = {};
    }
  }

  const current: Record<string, unknown> = { ...baseConfig };

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
