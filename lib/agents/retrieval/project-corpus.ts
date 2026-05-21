import { existsSync, readFileSync, statSync } from 'fs';
import { relative } from 'path';
import { inArray, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { canonicalAgentNameKey } from '@/lib/agents/agent-name';
import { scanFileAgents } from '@/lib/agents/tamtam-file-agents';
import { listProjectDocuments } from '@/lib/shared/project-documents';
import { getBranchContext } from '@/lib/git/git-branch';
import { loadFileConfig } from '@/lib/skills/tamtam-file-config';
import type { SourceKind } from './backend';

export interface ProjectRetrievalSource {
  recordId: string;
  sourceKind: SourceKind;
  sourceId: string;
  text: string;
  metadata: Record<string, string>;
  updatedAt: number | null;
}

function safeJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function buildSkillText(skill: { name: string; description: string; content: string }): string {
  return [
    `# ${skill.name}`,
    skill.description.trim() ? skill.description.trim() : '',
    skill.content.trim(),
  ].filter(Boolean).join('\n\n');
}

function buildProjectConfigText(projectPath: string, project: {
  testCommand: string | null;
  reviewPromptAddendum: string | null;
  fixPromptAddendum: string | null;
  qaUrl: string | null;
  website: string | null;
  customActions: string | null;
} | undefined): string {
  const fileConfig = loadFileConfig(projectPath);
  const lines: string[] = ['# Project Configuration'];

  if (fileConfig?.test_command?.trim()) {
    lines.push(`Committed test command: ${fileConfig.test_command.trim()}`);
  }
  if (project?.testCommand?.trim()) {
    lines.push(`Local test command override: ${project.testCommand.trim()}`);
  }
  if (project?.reviewPromptAddendum?.trim()) {
    lines.push(`Review guidance:\n${project.reviewPromptAddendum.trim()}`);
  }
  if (project?.fixPromptAddendum?.trim()) {
    lines.push(`Fix guidance:\n${project.fixPromptAddendum.trim()}`);
  }
  if (fileConfig?.commit_style?.trim()) {
    lines.push(`Commit style:\n${fileConfig.commit_style.trim()}`);
  }
  if (project?.qaUrl?.trim()) {
    lines.push(`QA URL: ${project.qaUrl.trim()}`);
  }
  if (project?.website?.trim()) {
    lines.push(`Website: ${project.website.trim()}`);
  }
  if (fileConfig?.safe_users?.length) {
    lines.push(`Trusted GitHub users: ${fileConfig.safe_users.join(', ')}`);
  }
  if (fileConfig?.custom_actions?.length) {
    const actions = fileConfig.custom_actions.map((action) => `- ${action.name}: ${action.command}`);
    lines.push(`Committed custom actions:\n${actions.join('\n')}`);
  }
  if (project?.customActions) {
    try {
      const actions = JSON.parse(project.customActions) as Array<{ name?: string; command?: string }>;
      const valid = actions
        .filter((action) => typeof action?.name === 'string' && typeof action?.command === 'string')
        .map((action) => `- ${action.name}: ${action.command}`);
      if (valid.length > 0) {
        lines.push(`Local custom actions:\n${valid.join('\n')}`);
      }
    } catch {}
  }

  return lines.length > 1 ? lines.join('\n\n') : '';
}

async function collectEffectiveProjectSkillIds(project: string, projectPath: string): Promise<string[]> {
  const agentRows = await db.select({ name: schema.agents.name, skillIds: schema.agents.skillIds })
    .from(schema.agents)
    .where(eq(schema.agents.project, project));
  const dbAgentKeys = new Set(agentRows.map((row) => canonicalAgentNameKey(row.name)));
  const skillIds = agentRows.flatMap((row) => safeJsonArray(row.skillIds));

  for (const agent of scanFileAgents(projectPath, project)) {
    if (dbAgentKeys.has(canonicalAgentNameKey(agent.name))) continue;
    skillIds.push(...agent.skillIds);
  }

  return Array.from(new Set(skillIds.filter((id) => !id.startsWith('persona:'))));
}

export async function collectProjectRetrievalSources(project: string, projectPath: string): Promise<ProjectRetrievalSource[]> {
  const sources: ProjectRetrievalSource[] = [];
  const branchContext = getBranchContext(projectPath);

  for (const filePath of listProjectDocuments(projectPath, { includeAgentDocs: branchContext.isDefaultBranch })) {
    if (!existsSync(/*turbopackIgnore: true*/ filePath)) continue;
    const text = readFileSync(/*turbopackIgnore: true*/ filePath, 'utf-8');
    if (!text.trim()) continue;
    // Use `path.relative` instead of a string-replace with a hardcoded
    // '/' separator. `listProjectDocuments` returns paths joined with
    // `path.sep`, so the previous string-replace would be a no-op on any
    // platform where `path.sep !== '/'` (sourceId would end up being the
    // full absolute path). TamTam targets Linux/macOS today, but the
    // idiomatic API is the right one to use.
    const sourceId = relative(projectPath, filePath);
    sources.push({
      recordId: `${project}:project_doc:${sourceId}`,
      sourceKind: 'project_doc',
      sourceId,
      text,
      metadata: { filePath: sourceId },
      updatedAt: statSync(/*turbopackIgnore: true*/ filePath).mtimeMs / 1000,
    });
  }

  const dbSkillIds = await collectEffectiveProjectSkillIds(project, projectPath);
  if (dbSkillIds.length > 0) {
    const skills = await db.select().from(schema.skills).where(inArray(schema.skills.id, dbSkillIds));
    for (const skill of skills) {
      const text = buildSkillText(skill);
      if (!text.trim()) continue;
      sources.push({
        recordId: `${project}:skill:${skill.id}`,
        sourceKind: 'skill',
        sourceId: skill.id,
        text,
        metadata: {
          skillId: skill.id,
          skillTitle: skill.name,
        },
        updatedAt: skill.updatedAt,
      });
    }
  }

  const projectRows = await db.select().from(schema.projects).where(eq(schema.projects.name, project)).limit(1);
  const projectRow = projectRows[0] ?? null;
  const configText = buildProjectConfigText(projectPath, projectRow);
  if (configText.trim()) {
    sources.push({
      recordId: `${project}:project_config:current`,
      sourceKind: 'project_config',
      sourceId: 'current',
      text: configText,
      metadata: { label: 'project config' },
      updatedAt: null,
    });
  }

  return sources;
}
