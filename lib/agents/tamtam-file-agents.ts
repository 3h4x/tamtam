import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getBranchContext, gitLsTreeSync, gitShowSync } from '@/lib/git/git-branch';
import { getFileAgentOverride } from '@/lib/agents/file-agent-overrides';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { parseOptionalAgentScheduleInput } from '@/lib/scheduling/agent-schedule';
import { isCliProvider } from '@/lib/usage/cli-providers';

export interface FileAgent {
  id: string;
  name: string;
  project: string;
  skillIds: string[];
  docPaths: string[];
  model: string;
  prompt: string;
  schedule: string | null;
  runner: string;
  enabled: boolean;
  provider: string | null;
  createdAt: number;
  updatedAt: number;
  source: 'file';
  filePath: string;
}

export interface FileAgentUpdates {
  prompt?: string;
  model?: string;
  schedule?: string | null;
  skillIds?: string[];
  runner?: string;
  enabled?: boolean;
  provider?: string | null;
}

// Canonical frontmatter key order for serialization
const FM_KEY_ORDER = ['provider', 'model', 'schedule', 'skillIds', 'runner', 'enabled'] as const;

function normalizeFileAgentProvider(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  return isCliProvider(raw) ? raw : null;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  let body = content;

  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end > 0) {
      const fm = content.slice(3, end).trim();
      for (const line of fm.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          meta[key] = value;
        }
      }
      body = content.slice(end + 4).trim();
    }
  }

  return { meta, body };
}

function parseSkillIds(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
  }
  return trimmed ? trimmed.split(/[\s,]+/).filter(Boolean) : [];
}

function buildFileAgent(
  filePath: string,
  name: string,
  projectName: string,
  content: string,
  now: number
): FileAgent {
  const { meta, body } = parseFrontmatter(content);
  // The `.md` file owns prompt + identity. Operational config (enabled,
  // schedule, model, runner, skillIds) is stored in the DB so the UI can
  // toggle them without dirtying a committed file. Frontmatter values are
  // used as a starting baseline; the DB override (if any) wins on every
  // field it explicitly sets.
  const override = getFileAgentOverride(projectName, name);
  const fileSkillIds = meta.skillIds ? parseSkillIds(meta.skillIds) : [];
  return {
    id: `file:${projectName}:${name}`,
    name,
    project: projectName,
    skillIds: override?.skillIds ?? fileSkillIds,
    docPaths: [],
    model: normalizeModelInput(override?.model ?? meta.model, 'normal'),
    prompt: body,
    schedule:
      override?.schedule !== undefined
        ? override.schedule
        : (meta.schedule?.trim() || null),
    runner: override?.runner ?? meta.runner ?? 'pm2',
    enabled:
      override?.enabled !== undefined
        ? override.enabled
        : meta.enabled !== 'false',
    provider: normalizeFileAgentProvider(meta.provider),
    createdAt: now,
    updatedAt: now,
    source: 'file',
    filePath,
  };
}

function serializeAgent(
  provider: string | null,
  model: string,
  schedule: string | null,
  skillIds: string[],
  runner: string,
  enabled: boolean,
  prompt: string
): string {
  const fmLines: string[] = [];

  for (const key of FM_KEY_ORDER) {
    if (key === 'provider' && provider) {
      fmLines.push(`provider: ${provider}`);
    } else if (key === 'model') {
      fmLines.push(`model: ${model}`);
    } else if (key === 'schedule' && schedule) {
      fmLines.push(`schedule: ${schedule}`);
    } else if (key === 'skillIds' && skillIds.length > 0) {
      fmLines.push(`skillIds: ${JSON.stringify(skillIds)}`);
    } else if (key === 'runner' && runner !== 'pm2') {
      fmLines.push(`runner: ${runner}`);
    } else if (key === 'enabled' && !enabled) {
      fmLines.push(`enabled: false`);
    }
  }

  return `---\n${fmLines.join('\n')}\n---\n\n${prompt}\n`;
}

export function scanFileAgents(projectPath: string, projectName: string): FileAgent[] {
  const ctx = getBranchContext(projectPath);
  const dir = join(projectPath, '.tamtam', 'agents');
  const now = Date.now() / 1000;

  if (!ctx.isDefaultBranch) {
    // On a feature/PR branch: only honour agents that exist on origin/<defaultBranch>.
    // This prevents an attacker's PR from registering new scheduled agents.
    const ref = `origin/${ctx.defaultBranch}`;
    const fileNames = gitLsTreeSync(projectPath, ref, '.tamtam/agents');
    const agents: FileAgent[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith('.md')) continue;
      const name = fileName.slice(0, -3);
      const filePath = join(dir, fileName);
      const content = gitShowSync(projectPath, ref, `.tamtam/agents/${fileName}`);
      if (content === null) continue;
      agents.push(buildFileAgent(filePath, name, projectName, content, now));
    }
    return agents;
  }

  // On the default branch: read from the working tree as before.
  if (!existsSync(dir)) return [];

  const agents: FileAgent[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    const filePath = join(dir, entry.name);
    try {
      const content = readFileSync(filePath, 'utf-8');
      agents.push(buildFileAgent(filePath, name, projectName, content, now));
    } catch {}
  }

  return agents;
}

export function loadFileAgent(
  projectPath: string,
  projectName: string,
  agentName: string
): FileAgent | null {
  const ctx = getBranchContext(projectPath);
  const filePath = join(projectPath, '.tamtam', 'agents', `${agentName}.md`);
  const now = Date.now() / 1000;

  if (!ctx.isDefaultBranch) {
    // On a feature/PR branch: read from origin/<defaultBranch> to avoid loading
    // agents that only exist on the feature branch.
    const content = gitShowSync(
      projectPath,
      `origin/${ctx.defaultBranch}`,
      `.tamtam/agents/${agentName}.md`
    );
    if (content === null) return null;
    return buildFileAgent(filePath, agentName, projectName, content, now);
  }

  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    return buildFileAgent(filePath, agentName, projectName, content, now);
  } catch {
    return null;
  }
}

/**
 * Write (merge) updates into .tamtam/agents/<name>.md.
 * Creates the file and directory if they don't exist.
 * Unset fields retain their current values from disk.
 */
export function writeFileAgent(
  projectPath: string,
  projectName: string,
  agentName: string,
  updates: FileAgentUpdates
): FileAgent {
  const dir = join(projectPath, '.tamtam', 'agents');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${agentName}.md`);

  // Load current values from the working-tree file (if it exists) to preserve unset fields.
  // We intentionally read from disk here even on a feature branch, because the user may have
  // edited the agent locally and we want to preserve their changes.
  const currentFromDisk = existsSync(filePath)
    ? (() => {
        try {
          const content = readFileSync(filePath, 'utf-8');
          return buildFileAgent(filePath, agentName, projectName, content, Date.now() / 1000);
        } catch {
          return null;
        }
      })()
    : null;
  // On feature branches the effective agent may come from origin/<default>
  // even when the working-tree file does not exist yet. Fall back to that
  // view so provider-only metadata edits don't wipe the committed prompt.
  const current = currentFromDisk ?? loadFileAgent(projectPath, projectName, agentName);

  const model = normalizeModelInput(updates.model ?? current?.model, 'normal');
  const rawSchedule = updates.schedule !== undefined ? updates.schedule : (current?.schedule ?? null);
  const { schedule, error: scheduleError } = parseOptionalAgentScheduleInput(rawSchedule);
  if (scheduleError) throw new Error(scheduleError);
  const skillIds = updates.skillIds ?? current?.skillIds ?? [];
  const runner = updates.runner ?? current?.runner ?? 'pm2';
  const enabled = updates.enabled !== undefined ? updates.enabled : (current?.enabled ?? true);
  const provider = updates.provider !== undefined
    ? normalizeFileAgentProvider(updates.provider)
    : (current?.provider ?? null);
  const prompt = updates.prompt ?? current?.prompt ?? '';

  const content = serializeAgent(provider, model, schedule, skillIds, runner, enabled, prompt);
  writeFileSync(filePath, content);

  return buildFileAgent(filePath, agentName, projectName, content, Date.now() / 1000);
}

/**
 * Delete .tamtam/agents/<name>.md. No-op if the file doesn't exist.
 */
export function deleteFileAgent(projectPath: string, agentName: string): void {
  const filePath = join(projectPath, '.tamtam', 'agents', `${agentName}.md`);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch {}
  }
}

export function parseFileAgentId(agentId: string): { project: string; name: string } | null {
  if (!agentId.startsWith('file:')) return null;
  const rest = agentId.slice('file:'.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx <= 0) return null;
  return { project: rest.slice(0, colonIdx), name: rest.slice(colonIdx + 1) };
}
