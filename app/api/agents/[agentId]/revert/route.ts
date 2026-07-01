import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { clearAgentsCache, normalizeAgent } from '@/lib/agents/agents-cache';
import { findAgentNameConflict } from '@/lib/agents/agent-conflicts';
import { recordAgentRevision } from '@/lib/agents/revisions';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { errMsg } from '@/lib/shared/types';

type AgentSnapshot = typeof schema.agents.$inferSelect;

function parseSnapshot(raw: string): AgentSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AgentSnapshot>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.project !== 'string' ||
      typeof parsed.skillIds !== 'string' ||
      typeof parsed.model !== 'string' ||
      typeof parsed.prompt !== 'string' ||
      typeof parsed.enabled !== 'boolean'
    ) {
      return null;
    }
    return parsed as AgentSnapshot;
  } catch {
    return null;
  }
}

function parseSkillIds(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function syncAgentSideEffects(existing: AgentSnapshot, agent: AgentSnapshot): Promise<void> {
  const skillIds = parseSkillIds(agent.skillIds);
  try {
    const identityChanged = existing.name !== agent.name || existing.project !== agent.project;
    if (identityChanged) {
      await uninstallAgentSchedule(agent.id, existing.project, existing.name);
    }
    if (agent.schedule && agent.enabled && (agent.prompt || skillIds.length > 0)) {
      await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.project, agent.name);
    } else {
      await uninstallAgentSchedule(agent.id, agent.project, agent.name);
    }
  } catch (e: unknown) {
    console.error(`Failed to update schedule for agent ${agent.id}:`, errMsg(e));
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;

  const body = await request.json().catch(() => ({})) as { revisionId?: unknown; note?: unknown };
  const revisionId = Number(body.revisionId);
  if (!Number.isInteger(revisionId) || revisionId <= 0) {
    return NextResponse.json({ detail: 'revisionId is required' }, { status: 400 });
  }

  const existing = (await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1))[0] ?? null;
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const revision = (await db
    .select()
    .from(schema.agentRevisions)
    .where(and(
      eq(schema.agentRevisions.entityId, agentId),
      eq(schema.agentRevisions.id, revisionId),
    ))
    .limit(1))[0] ?? null;
  if (!revision) return NextResponse.json({ detail: 'revision not found' }, { status: 404 });

  const snapshot = parseSnapshot(revision.snapshot);
  if (!snapshot) return NextResponse.json({ detail: 'revision snapshot is invalid' }, { status: 422 });

  if (existing.kind === 'system') {
    await recordAgentRevision(existing, body.note ?? `Revert to revision ${revisionId}`);
    await db.update(schema.agents)
      .set({ enabled: snapshot.enabled, updatedAt: Date.now() / 1000 })
      .where(eq(schema.agents.id, agentId))
      .execute();
  } else {
    const conflict = await findAgentNameConflict(snapshot.project, snapshot.name, {
      excludeDbAgentId: existing.id,
    });
    if (conflict) {
      return NextResponse.json({ detail: `agent '${snapshot.name}' already exists for ${snapshot.project}` }, { status: 409 });
    }

    await recordAgentRevision(existing, body.note ?? `Revert to revision ${revisionId}`);
    await db.update(schema.agents)
      .set({
        name: snapshot.name,
        project: snapshot.project,
        skillIds: snapshot.skillIds,
        docPaths: snapshot.docPaths,
        model: snapshot.model,
        prompt: snapshot.prompt,
        schedule: snapshot.schedule,
        enabled: snapshot.enabled,
        boostable: snapshot.boostable,
        provider: snapshot.provider,
        fallbackEnabled: snapshot.fallbackEnabled,
        prerequisiteCommand: snapshot.prerequisiteCommand,
        permissionMode: snapshot.permissionMode,
        kind: snapshot.kind,
        role: snapshot.role,
        autopilotState: snapshot.autopilotState,
        updatedAt: Date.now() / 1000,
      })
      .where(eq(schema.agents.id, agentId))
      .execute();
  }

  clearAgentsCache();
  const agent = (await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1))[0] ?? null;
  if (agent) await syncAgentSideEffects(existing, agent);
  return NextResponse.json({ agent: agent ? normalizeAgent(agent) : null });
}
