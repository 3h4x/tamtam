import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface FileAgent {
  id: string;
  name: string;
  project: string;
  skillIds: string[];
  model: string;
  prompt: string;
  schedule: string | null;
  runner: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  source: 'file';
  filePath: string;
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
  return {
    id: `file:${projectName}:${name}`,
    name,
    project: projectName,
    skillIds: meta.skillIds ? parseSkillIds(meta.skillIds) : [],
    model: meta.model || 'sonnet',
    prompt: body,
    schedule: meta.schedule?.trim() || null,
    runner: meta.runner || 'pm2',
    enabled: meta.enabled !== 'false',
    createdAt: now,
    updatedAt: now,
    source: 'file',
    filePath,
  };
}

export function scanFileAgents(projectPath: string, projectName: string): FileAgent[] {
  const dir = join(projectPath, '.tamtam', 'agents');
  if (!existsSync(dir)) return [];

  const agents: FileAgent[] = [];
  const now = Date.now() / 1000;

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
  const filePath = join(projectPath, '.tamtam', 'agents', `${agentName}.md`);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    return buildFileAgent(filePath, agentName, projectName, content, Date.now() / 1000);
  } catch {
    return null;
  }
}

export function parseFileAgentId(agentId: string): { project: string; name: string } | null {
  if (!agentId.startsWith('file:')) return null;
  const rest = agentId.slice('file:'.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx <= 0) return null;
  return { project: rest.slice(0, colonIdx), name: rest.slice(colonIdx + 1) };
}
