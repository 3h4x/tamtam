import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { errMsg } from '@/lib/shared/types';
import { clearAgentsCache, normalizeAgent } from '@/lib/agents/agents-cache';
import { findAgentNameConflict } from '@/lib/agents/agent-conflicts';
import { normalizeAgentNameInput } from '@/lib/agents/agent-name';
import { parseFileAgentId, loadFileAgent, writeFileAgent, deleteFileAgent } from '@/lib/agents/tamtam-file-agents';
import { setFileAgentOverride, deleteFileAgentOverride } from '@/lib/agents/file-agent-overrides';
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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const parsed = parseFileAgentId(agentId);
  if (parsed) {
    const projPath = resolveProjectPath(parsed.project);
    if (!projPath) return NextResponse.json({ detail: 'not found' }, { status: 404 });
    const agent = loadFileAgent(projPath, parsed.project, parsed.name);
    if (!agent) return NextResponse.json({ detail: 'not found' }, { status: 404 });
    return NextResponse.json({ agent: withEffectivePrerequisite(agent) });
  }

  const agentRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  const agent = agentRows[0] ?? null;
  if (!agent) return NextResponse.json({ detail: 'not found' }, { status: 404 });
  return NextResponse.json({ agent: normalizeAgent(agent) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const parsedFile = parseFileAgentId(agentId);
  const body = await request.json();
  const provider = body.provider === null ? null : (isCliProvider(body.provider) ? body.provider : undefined);
  const { model: parsedModel, error: modelError } = parseOptionalKnownModelInput(body.model, 'normal');
  if (modelError) return NextResponse.json({ detail: modelError }, { status: 400 });
  const parsedSchedule = body.schedule !== undefined
    ? parseOptionalAgentScheduleInput(body.schedule)
    : { schedule: undefined, error: null };
  if (parsedSchedule.error) return NextResponse.json({ detail: parsedSchedule.error }, { status: 400 });

  if (parsedFile) {
    const projPath = resolveProjectPath(parsedFile.project);
    if (!projPath) return NextResponse.json({ detail: 'not found' }, { status: 404 });
    if (!loadFileAgent(projPath, parsedFile.project, parsedFile.name)) {
      return NextResponse.json({ detail: 'not found' }, { status: 404 });
    }
    try {
      // Operational config goes to the DB override so the toggle/edit UI
      // doesn't dirty a tracked .md file. Only the prompt belongs in the
      // file (the agent's "identity"); everything else is per-environment.
      if (
        body.enabled !== undefined ||
        body.schedule !== undefined ||
        body.model !== undefined ||
        body.runner !== undefined ||
        body.skillIds !== undefined
      ) {
        await setFileAgentOverride(parsedFile.project, parsedFile.name, {
          enabled: body.enabled,
          schedule: body.schedule !== undefined ? parsedSchedule.schedule : undefined,
          model: parsedModel ?? undefined,
          runner: body.runner,
          skillIds: body.skillIds,
        });
      }
      // Prompt edits always flow to the file. Provider frontmatter and the
      // prerequisite shell command are also committed state, so updates to
      // either must write the file too.
      if (body.prompt !== undefined || provider !== undefined || body.prerequisiteCommand !== undefined) {
        const prerequisiteCommand = parsePrerequisiteCommandInput(body.prerequisiteCommand);
        writeFileAgent(projPath, parsedFile.project, parsedFile.name, { prompt: body.prompt, provider, prerequisiteCommand });
      }
      const updated = loadFileAgent(projPath, parsedFile.project, parsedFile.name);
      if (!updated) return NextResponse.json({ detail: 'not found after write' }, { status: 500 });
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

  const existingRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  const existing = existingRows[0] ?? null;
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  // Capture identity before update so we can clean up any compatibility
  // scheduler state if name, project, or runner changes.
  const oldName = existing.name;
  const oldProject = existing.project;
  const oldRunner = existing.runner;
  let nextName = existing.name;

  if (body.name !== undefined) {
    const parsedName = normalizeAgentNameInput(body.name);
    if (parsedName.error) {
      return NextResponse.json({ detail: parsedName.error }, { status: 400 });
    }
    nextName = parsedName.name!;
    const conflict = await findAgentNameConflict(existing.project, nextName, {
      excludeDbAgentId: existing.id,
      excludeFileAgentName: existing.name,
    });
    if (conflict) {
      return NextResponse.json({ detail: `agent '${nextName}' already exists for ${existing.project}` }, { status: 409 });
    }
  }

  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  if (body.name !== undefined) updates.name = nextName;
  if (body.skillIds !== undefined) updates.skillIds = JSON.stringify(body.skillIds);
  if (body.docPaths !== undefined) updates.docPaths = JSON.stringify(body.docPaths);
  if (body.model !== undefined) updates.model = parsedModel ?? 'normal';
  if (body.prompt !== undefined) updates.prompt = body.prompt;
  if (body.schedule !== undefined) updates.schedule = parsedSchedule.schedule;
  if (body.runner !== undefined) updates.runner = body.runner;
  if (body.enabled !== undefined) updates.enabled = body.enabled;
  if (provider !== undefined) updates.provider = provider;
  if (body.prerequisiteCommand !== undefined) {
    updates.prerequisiteCommand = parsePrerequisiteCommandInput(body.prerequisiteCommand) ?? '';
  }

  await db.update(schema.agents).set(updates).where(eq(schema.agents.id, agentId)).execute();
  clearAgentsCache();
  const updatedRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  const agent = updatedRows[0] ?? null;

  // Sync to .tamtam/agents/<name>.md for version control
  if (agent) {
    const projPath = resolveProjectPath(agent.project);
    if (projPath) {
      try {
        if (oldName !== agent.name) {
          deleteFileAgent(projPath, oldName);
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
  }

  // Update schedule (fired by graphile-worker cron pool)
  if (agent) {
    try {
      const identityChanged =
        agent.name !== oldName || agent.project !== oldProject || agent.runner !== oldRunner;
      if (identityChanged) {
        await uninstallAgentSchedule(agentId, oldProject, oldName);
      }

      const skillIds: string[] = JSON.parse(agent.skillIds || '[]');
      if (agent.schedule && agent.enabled && (agent.prompt || skillIds.length > 0)) {
        await installAgentSchedule(agentId, agent.schedule, agent.prompt, agent.project, agent.name);
      } else {
        await uninstallAgentSchedule(agentId, agent.project, agent.name);
      }
    } catch (e: unknown) {
      console.error(`Failed to update schedule for agent ${agentId}:`, errMsg(e));
    }
  }

  return NextResponse.json({ agent: agent ? normalizeAgent(agent) : null });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const parsedFileDel = parseFileAgentId(agentId);
  if (parsedFileDel) {
    const projPath = resolveProjectPath(parsedFileDel.project);
    if (!projPath) return NextResponse.json({ detail: 'not found' }, { status: 404 });
    deleteFileAgent(projPath, parsedFileDel.name);
    // Drop the DB override too — otherwise re-creating the agent later
    // would silently inherit a stale enabled/schedule.
    deleteFileAgentOverride(parsedFileDel.project, parsedFileDel.name);
    return NextResponse.json({ status: 'deleted' });
  }

  // Uninstall schedule before deleting
  const deleteRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  const agent = deleteRows[0] ?? null;
  try {
    await uninstallAgentSchedule(agentId, agent?.project, agent?.name);
  } catch (e: unknown) {
    console.error(`Failed to uninstall schedule for agent ${agentId}:`, errMsg(e));
  }

  // Also remove .tamtam/agents/<name>.md
  if (agent) {
    const projPath = resolveProjectPath(agent.project);
    if (projPath) deleteFileAgent(projPath, agent.name);
  }

  await db.delete(schema.agents).where(eq(schema.agents.id, agentId)).execute();
  clearAgentsCache();
  return NextResponse.json({ status: 'deleted' });
}
