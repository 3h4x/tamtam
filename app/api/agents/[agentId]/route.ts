import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { errMsg } from '@/lib/shared/types';
import { clearAgentsCache, normalizeAgent } from '@/lib/agents/agents-cache';
import { findAgentNameConflict } from '@/lib/agents/agent-conflicts';
import { normalizeAgentNameInput } from '@/lib/agents/agent-name';
import { parseAgentRole } from '@/lib/agents/roles';
import { parseOptionalKnownModelInput } from '@/lib/agents/model-aliases';
import { parseOptionalAgentScheduleInput } from '@/lib/scheduling/agent-schedule';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { parsePrerequisiteCommandInput } from '@/lib/agents/prerequisites';
import { parseOptionalPermissionModeInput } from '@/lib/shared/config';
import { recordAgentRevision } from '@/lib/agents/revisions';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

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

  const body = await request.json();
  const provider = body.provider === null ? null : (isCliProvider(body.provider) ? body.provider : undefined);
  const { model: parsedModel, error: modelError } = parseOptionalKnownModelInput(body.model, 'normal');
  if (modelError) return NextResponse.json({ detail: modelError }, { status: 400 });
  const parsedSchedule = body.schedule !== undefined
    ? parseOptionalAgentScheduleInput(body.schedule)
    : { schedule: undefined, error: null };
  if (parsedSchedule.error) return NextResponse.json({ detail: parsedSchedule.error }, { status: 400 });
  const { mode: parsedPermissionMode, error: permissionModeError } = parseOptionalPermissionModeInput(body.permissionMode);
  if (body.permissionMode !== undefined && permissionModeError) {
    return NextResponse.json({ detail: permissionModeError }, { status: 400 });
  }

  const existingRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  const existing = existingRows[0] ?? null;
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  // Capture identity before update so we can clean up any compatibility
  // scheduler state if name or project changes.
  const oldName = existing.name;
  const oldProject = existing.project;
  let nextName = existing.name;

  if (body.name !== undefined) {
    const parsedName = normalizeAgentNameInput(body.name);
    if (parsedName.error) {
      return NextResponse.json({ detail: parsedName.error }, { status: 400 });
    }
    nextName = parsedName.name!;
    const conflict = await findAgentNameConflict(existing.project, nextName, {
      excludeDbAgentId: existing.id,
    });
    if (conflict) {
      return NextResponse.json({ detail: `agent '${nextName}' already exists for ${existing.project}` }, { status: 409 });
    }
  }

  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  const isSystemAgent = existing.kind === 'system';
  // System agents are auto-managed. Only `enabled` is user-tunable from
  // this route — identity, behavior, AND schedule are owned by TamTam.
  // The schedule for `documentation-reindex-vectors` is set via
  // `retrieval_reindex_interval_hours` in /settings.
  if (isSystemAgent && body.schedule !== undefined) {
    return NextResponse.json({ detail: 'System agent schedule is managed by settings' }, { status: 400 });
  }
  if (!isSystemAgent && body.name !== undefined) updates.name = nextName;
  if (!isSystemAgent && body.skillIds !== undefined) updates.skillIds = JSON.stringify(body.skillIds);
  if (!isSystemAgent && body.docPaths !== undefined) updates.docPaths = JSON.stringify(body.docPaths);
  if (!isSystemAgent && body.model !== undefined) updates.model = parsedModel ?? 'normal';
  if (!isSystemAgent && body.prompt !== undefined) updates.prompt = body.prompt;
  if (!isSystemAgent && body.schedule !== undefined) updates.schedule = parsedSchedule.schedule;
  if (body.enabled !== undefined) updates.enabled = body.enabled;
  if (!isSystemAgent && body.boostable !== undefined) updates.boostable = body.boostable;
  if (!isSystemAgent && provider !== undefined) updates.provider = provider;
  if (!isSystemAgent && body.fallbackEnabled !== undefined) updates.fallbackEnabled = body.fallbackEnabled === true;
  if (!isSystemAgent && body.prerequisiteCommand !== undefined) {
    updates.prerequisiteCommand = parsePrerequisiteCommandInput(body.prerequisiteCommand) ?? '';
  }
  if (!isSystemAgent && body.permissionMode !== undefined) updates.permissionMode = parsedPermissionMode;
  if (!isSystemAgent && body.role !== undefined) updates.role = parseAgentRole(body.role);

  await recordAgentRevision(existing, body.note);
  await db.update(schema.agents).set(updates).where(eq(schema.agents.id, agentId)).execute();
  clearAgentsCache();
  const updatedRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  const agent = updatedRows[0] ?? null;

  // Parse skillIds once — the schedule decision below consumes it.
  // Defaults to [] on missing/malformed JSON.
  let skillIds: string[] = [];
  if (agent) {
    try { skillIds = JSON.parse(agent.skillIds || '[]'); } catch { /* keep [] */ }
  }

  // Update schedule (fired by graphile-worker cron pool)
  if (agent) {
    try {
      const identityChanged =
        agent.name !== oldName || agent.project !== oldProject;
      if (identityChanged) {
        await uninstallAgentSchedule(agentId, oldProject, oldName);
      }

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

  // Uninstall schedule before deleting
  const deleteRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  const agent = deleteRows[0] ?? null;
  try {
    await uninstallAgentSchedule(agentId, agent?.project, agent?.name);
  } catch (e: unknown) {
    console.error(`Failed to uninstall schedule for agent ${agentId}:`, errMsg(e));
  }

  // For system (built-in) agents, record a dismissal marker so the auto
  // seeder doesn't recreate the row on next boot or on project changes.
  if (agent && agent.kind === 'system') {
    try {
      const { markSystemAgentDismissed } = await import('@/lib/agents/system/seed');
      await markSystemAgentDismissed(agent.project, agent.name);
    } catch (e: unknown) {
      console.error(`Failed to mark system agent dismissed for ${agentId}:`, errMsg(e));
    }
  }

  await db.delete(schema.agents).where(eq(schema.agents.id, agentId)).execute();
  clearAgentsCache();
  return NextResponse.json({ status: 'deleted' });
}
