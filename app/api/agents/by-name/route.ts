import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { errMsg } from '@/lib/shared/types';
import { clearAgentsCache, normalizeAgent } from '@/lib/agents/agents-cache';
import { findAgentNameConflict } from '@/lib/agents/agent-conflicts';
import { canonicalAgentNameKey, normalizeAgentNameInput } from '@/lib/agents/agent-name';
import { deleteFileAgent, renameFileAgent, scanFileAgents, writeFileAgent } from '@/lib/agents/tamtam-file-agents';
import { deleteFileAgentOverride, getFileAgentOverride, setFileAgentOverride } from '@/lib/agents/file-agent-overrides';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { parseOptionalKnownModelInput } from '@/lib/agents/model-aliases';
import { parseOptionalAgentScheduleInput } from '@/lib/scheduling/agent-schedule';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { parsePrerequisiteCommandInput, resolveAgentPrerequisiteCommand } from '@/lib/agents/issue-cruncher';

function withEffectivePrerequisite<T extends { project: string; skillIds: string[]; prerequisiteCommand?: string | null }>(
  agent: T,
): T {
  return {
    ...agent,
    prerequisiteCommand: resolveAgentPrerequisiteCommand({
      project: agent.project,
      skillIds: agent.skillIds,
      prerequisiteCommand: agent.prerequisiteCommand,
    }),
  };
}

async function findDbAgentByProjectAndName(project: string, name: string) {
  const targetKey = canonicalAgentNameKey(name);
  const rows = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.project, project));
  return rows.find((agent) => canonicalAgentNameKey(agent.name) === targetKey) ?? null;
}

// PATCH /api/agents/by-name
// Lets an agent update itself by project+name without knowing its UUID.
// Works for both DB agents and file-based agents (.tamtam/agents/*.md).
// Body: { project, name, ...fields } or { project, currentName, name, ...fields } for rename.
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { project, currentName, name, ...fields } = body;
  const provider = fields.provider === null ? null : (isCliProvider(fields.provider) ? fields.provider : undefined);
  const prerequisiteCommand = parsePrerequisiteCommandInput(fields.prerequisiteCommand);

  if (!project?.trim()) {
    return NextResponse.json({ detail: 'project and name are required' }, { status: 400 });
  }
  const projectName = project.trim();
  const lookupRawName = typeof currentName === 'string' ? currentName : name;
  const parsedLookupName = normalizeAgentNameInput(lookupRawName);
  if (parsedLookupName.error) return NextResponse.json({ detail: parsedLookupName.error }, { status: 400 });
  const lookupName = parsedLookupName.name!;
  let requestedName: string | null = null;
  if (typeof currentName === 'string' && name !== undefined) {
    const parsedUpdatedName = normalizeAgentNameInput(name);
    if (parsedUpdatedName.error) return NextResponse.json({ detail: parsedUpdatedName.error }, { status: 400 });
    requestedName = parsedUpdatedName.name!;
  }
  const { model: parsedModel, error: modelError } = parseOptionalKnownModelInput(fields.model, 'normal');
  if (modelError) return NextResponse.json({ detail: modelError }, { status: 400 });
  const parsedSchedule = fields.schedule !== undefined
    ? parseOptionalAgentScheduleInput(fields.schedule)
    : { schedule: undefined, error: null };
  if (parsedSchedule.error) return NextResponse.json({ detail: parsedSchedule.error }, { status: 400 });

  // Try DB agent first
  const existing = await findDbAgentByProjectAndName(projectName, lookupName);

  if (existing) {
    const nextName = requestedName ?? existing.name;
    if (requestedName !== null) {
      const conflict = await findAgentNameConflict(projectName, nextName, {
        excludeDbAgentId: existing.id,
        excludeFileAgentName: existing.name,
      });
      if (conflict) {
        return NextResponse.json({ detail: `agent '${nextName}' already exists for ${projectName}` }, { status: 409 });
      }
    }
    const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
    if (requestedName !== null) updates.name = nextName;
    if (fields.skillIds !== undefined) updates.skillIds = JSON.stringify(fields.skillIds);
    if (fields.model !== undefined) updates.model = parsedModel ?? 'normal';
    if (fields.prompt !== undefined) updates.prompt = fields.prompt;
    if (fields.schedule !== undefined) updates.schedule = parsedSchedule.schedule;
    if (fields.runner !== undefined) updates.runner = fields.runner;
    if (fields.enabled !== undefined) updates.enabled = fields.enabled;
    if (provider !== undefined) updates.provider = provider;
    if (fields.prerequisiteCommand !== undefined) updates.prerequisiteCommand = prerequisiteCommand ?? '';

    await db.update(schema.agents).set(updates).where(eq(schema.agents.id, existing.id)).execute();
    clearAgentsCache();

    const agentRows = await db.select().from(schema.agents).where(eq(schema.agents.id, existing.id)).limit(1);
    const agent = agentRows[0] ?? null;

    if (agent) {
      // Sync to .tamtam/agents/<name>.md for version control
      const projPath = resolveProjectPath(agent.project);
      if (projPath) {
        try {
          if (existing.name !== agent.name) {
            deleteFileAgent(projPath, existing.name);
          }
          const skillIds: string[] = JSON.parse(agent.skillIds || '[]');
          writeFileAgent(projPath, agent.project, agent.name, {
            prompt: agent.prompt,
            model: agent.model,
            schedule: agent.schedule,
            skillIds,
            runner: agent.runner,
            enabled: agent.enabled,
            provider: agent.provider,
            prerequisiteCommand: agent.prerequisiteCommand,
          });
        } catch { /* non-fatal */ }
      }
      try {
        const hasSkills = JSON.parse(agent.skillIds || '[]').length > 0;
        if (agent.schedule && agent.enabled && (agent.prompt || hasSkills)) {
          await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.project, agent.name);
        } else {
          await uninstallAgentSchedule(agent.id, agent.project, agent.name);
        }
      } catch (e: unknown) {
        console.error(`Failed to update schedule for agent ${agent.id}:`, errMsg(e));
      }
    }

    return NextResponse.json({ agent: agent ? normalizeAgent(agent) : null });
  }

  // Fall back to file agent
  const projPath = resolveProjectPath(projectName);
  if (projPath) {
    const fileAgent = scanFileAgents(projPath, projectName)
      .find((agent) => canonicalAgentNameKey(agent.name) === canonicalAgentNameKey(lookupName)) ?? null;
    if (fileAgent) {
      try {
        const nextName = requestedName ?? fileAgent.name;
        if (requestedName !== null) {
          const conflict = await findAgentNameConflict(projectName, nextName, {
            excludeFileAgentName: fileAgent.name,
          });
          if (conflict) {
            return NextResponse.json({ detail: `agent '${nextName}' already exists for ${projectName}` }, { status: 409 });
          }
        }

        const override = await getFileAgentOverride(projectName, fileAgent.name);
        const fileUpdates = {
          prompt: fields.prompt !== undefined ? fields.prompt : fileAgent.prompt,
          model: fields.model !== undefined ? (parsedModel ?? undefined) : fileAgent.model,
          schedule: fields.schedule !== undefined ? parsedSchedule.schedule : fileAgent.schedule,
          skillIds: fields.skillIds !== undefined ? fields.skillIds : fileAgent.skillIds,
          runner: fields.runner !== undefined ? fields.runner : fileAgent.runner,
          enabled: fields.enabled !== undefined ? fields.enabled : fileAgent.enabled,
          provider: provider !== undefined ? provider : fileAgent.provider,
          prerequisiteCommand: fields.prerequisiteCommand !== undefined ? prerequisiteCommand : fileAgent.prerequisiteCommand,
        };
        const updated = fileAgent.name !== nextName
          ? renameFileAgent(projPath, projectName, fileAgent.name, nextName, fileUpdates)
          : writeFileAgent(projPath, projectName, nextName, fileUpdates);
        if (fileAgent.name !== nextName) {
          if (override) {
            await setFileAgentOverride(projectName, nextName, override);
            deleteFileAgentOverride(projectName, fileAgent.name);
          }
        }
        try {
          if (updated.schedule && updated.enabled && (updated.prompt || updated.skillIds.length > 0)) {
            await installAgentSchedule(updated.id, updated.schedule, updated.prompt, updated.project, updated.name);
          } else {
            await uninstallAgentSchedule(updated.id, updated.project, updated.name);
          }
        } catch (e: unknown) {
          console.error(`Failed to update schedule for file agent ${updated.id}:`, errMsg(e));
        }
        return NextResponse.json({ agent: withEffectivePrerequisite(updated) });
      } catch (e: unknown) {
        return NextResponse.json({ detail: `Failed to write agent file: ${errMsg(e)}` }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ detail: 'not found' }, { status: 404 });
}
