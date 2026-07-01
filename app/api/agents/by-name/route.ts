import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { errMsg } from '@/lib/shared/types';
import { clearAgentsCache, normalizeAgent } from '@/lib/agents/agents-cache';
import { findAgentNameConflict } from '@/lib/agents/agent-conflicts';
import { canonicalAgentNameKey, normalizeAgentNameInput } from '@/lib/agents/agent-name';
import { parseOptionalKnownModelInput } from '@/lib/agents/model-aliases';
import { parseOptionalAgentScheduleInput } from '@/lib/scheduling/agent-schedule';
import { parseOptionalPermissionModeInput } from '@/lib/shared/config';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { parsePrerequisiteCommandInput } from '@/lib/agents/prerequisites';
import { recordAgentRevision } from '@/lib/agents/revisions';

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
  const { mode: parsedPermissionMode, error: permissionModeError } = parseOptionalPermissionModeInput(fields.permissionMode);
  if (fields.permissionMode !== undefined && permissionModeError) {
    return NextResponse.json({ detail: permissionModeError }, { status: 400 });
  }

  const existing = await findDbAgentByProjectAndName(projectName, lookupName);
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const nextName = requestedName ?? existing.name;
  const isSystemAgent = existing.kind === 'system';
  if (isSystemAgent && fields.schedule !== undefined) {
    return NextResponse.json({ detail: 'System agent schedule is managed by settings' }, { status: 400 });
  }
  if (requestedName !== null) {
    const conflict = await findAgentNameConflict(projectName, nextName, {
      excludeDbAgentId: existing.id,
    });
    if (conflict) {
      return NextResponse.json({ detail: `agent '${nextName}' already exists for ${projectName}` }, { status: 409 });
    }
  }
  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  if (!isSystemAgent && requestedName !== null) updates.name = nextName;
  if (!isSystemAgent && fields.skillIds !== undefined) updates.skillIds = JSON.stringify(fields.skillIds);
  if (!isSystemAgent && fields.model !== undefined) updates.model = parsedModel ?? 'normal';
  if (!isSystemAgent && fields.prompt !== undefined) updates.prompt = fields.prompt;
  if (!isSystemAgent && fields.schedule !== undefined) updates.schedule = parsedSchedule.schedule;
  if (fields.enabled !== undefined) updates.enabled = fields.enabled;
  if (!isSystemAgent && fields.boostable !== undefined) updates.boostable = fields.boostable;
  if (!isSystemAgent && provider !== undefined) updates.provider = provider;
  if (!isSystemAgent && fields.fallbackEnabled !== undefined) updates.fallbackEnabled = fields.fallbackEnabled === true;
  if (!isSystemAgent && fields.prerequisiteCommand !== undefined) updates.prerequisiteCommand = prerequisiteCommand ?? '';
  if (!isSystemAgent && fields.permissionMode !== undefined) updates.permissionMode = parsedPermissionMode;

  await recordAgentRevision(existing, fields.note);
  await db.update(schema.agents).set(updates).where(eq(schema.agents.id, existing.id)).execute();
  clearAgentsCache();

  const agentRows = await db.select().from(schema.agents).where(eq(schema.agents.id, existing.id)).limit(1);
  const agent = agentRows[0] ?? null;

  if (agent) {
    let skillIds: string[] = [];
    try { skillIds = JSON.parse(agent.skillIds || '[]'); } catch { /* keep empty */ }
    try {
      const hasSkills = skillIds.length > 0;
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
