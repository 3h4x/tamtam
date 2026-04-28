import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/agent-scheduler';
import { errMsg } from '@/lib/types';
import { clearAgentsCache, normalizeAgent } from '@/lib/agents-cache';
import { parseFileAgentId, loadFileAgent, writeFileAgent, deleteFileAgent } from '@/lib/tamtam-file-agents';
import { resolveProjectPath } from '@/lib/project-data';

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
    return NextResponse.json({ agent });
  }

  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!agent) return NextResponse.json({ detail: 'not found' }, { status: 404 });
  return NextResponse.json({ agent: normalizeAgent(agent) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const parsedFile = parseFileAgentId(agentId);
  if (parsedFile) {
    const projPath = resolveProjectPath(parsedFile.project);
    if (!projPath) return NextResponse.json({ detail: 'not found' }, { status: 404 });
    if (!loadFileAgent(projPath, parsedFile.project, parsedFile.name)) {
      return NextResponse.json({ detail: 'not found' }, { status: 404 });
    }
    const body = await request.json();
    try {
      const updated = writeFileAgent(projPath, parsedFile.project, parsedFile.name, {
        prompt: body.prompt,
        model: body.model,
        schedule: body.schedule,
        skillIds: body.skillIds,
        runner: body.runner,
        enabled: body.enabled,
      });
      try {
        if (updated.schedule && updated.enabled && (updated.prompt || updated.skillIds.length > 0)) {
          await installAgentSchedule(updated.id, updated.schedule, updated.prompt, updated.runner, updated.project, updated.name);
        } else {
          await uninstallAgentSchedule(updated.id, updated.runner, updated.project, updated.name);
        }
      } catch (e: unknown) {
        console.error(`Failed to update schedule for file agent ${updated.id}:`, errMsg(e));
      }
      return NextResponse.json({ agent: updated });
    } catch (e: unknown) {
      return NextResponse.json({ detail: `Failed to write agent file: ${errMsg(e)}` }, { status: 500 });
    }
  }

  const existing = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  // Capture identity before update so we can clean up the old PM2 entry if
  // name, project, or runner changes — these produce a different PM2 process
  // name and the old entry would otherwise be orphaned.
  const oldName = existing.name;
  const oldProject = existing.project;
  const oldRunner = existing.runner;

  const body = await request.json();
  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.skillIds !== undefined) updates.skillIds = JSON.stringify(body.skillIds);
  if (body.docPaths !== undefined) updates.docPaths = JSON.stringify(body.docPaths);
  if (body.model !== undefined) updates.model = body.model;
  if (body.prompt !== undefined) updates.prompt = body.prompt;
  if (body.schedule !== undefined) updates.schedule = body.schedule || null;
  if (body.runner !== undefined) updates.runner = body.runner;
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  db.update(schema.agents).set(updates).where(eq(schema.agents.id, agentId)).run();
  clearAgentsCache();
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();

  // Sync to .tamtam/agents/<name>.md for version control
  if (agent) {
    const projPath = resolveProjectPath(agent.project);
    if (projPath) {
      try {
        const skillIds: string[] = JSON.parse(agent.skillIds || '[]');
        writeFileAgent(projPath, agent.project, agent.name, {
          prompt: agent.prompt,
          model: agent.model,
          schedule: agent.schedule,
          skillIds,
          runner: agent.runner,
          enabled: agent.enabled,
        });
      } catch { /* non-fatal */ }
    }
  }

  // Update schedule (uses pm2 or launchctl based on runner)
  if (agent) {
    try {
      // If name, project, or runner changed, the old PM2 entry has a different
      // name and won't be touched by install/uninstall below — delete it first.
      const identityChanged =
        agent.name !== oldName || agent.project !== oldProject || agent.runner !== oldRunner;
      if (identityChanged) {
        await uninstallAgentSchedule(agentId, oldRunner, oldProject, oldName);
      }

      const skillIds: string[] = JSON.parse(agent.skillIds || '[]');
      if (agent.schedule && agent.enabled && (agent.prompt || skillIds.length > 0)) {
        await installAgentSchedule(agentId, agent.schedule, agent.prompt, agent.runner, agent.project, agent.name);
      } else {
        await uninstallAgentSchedule(agentId, agent.runner, agent.project, agent.name);
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
    return NextResponse.json({ status: 'deleted' });
  }

  // Uninstall schedule before deleting
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  try {
    await uninstallAgentSchedule(agentId, agent?.runner || 'pm2', agent?.project, agent?.name);
  } catch (e: unknown) {
    console.error(`Failed to uninstall schedule for agent ${agentId}:`, errMsg(e));
  }

  // Also remove .tamtam/agents/<name>.md
  if (agent) {
    const projPath = resolveProjectPath(agent.project);
    if (projPath) deleteFileAgent(projPath, agent.name);
  }

  db.delete(schema.agents).where(eq(schema.agents.id, agentId)).run();
  clearAgentsCache();
  return NextResponse.json({ status: 'deleted' });
}
