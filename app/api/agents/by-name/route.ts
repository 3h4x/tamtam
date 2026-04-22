import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/agent-scheduler';
import { errMsg } from '@/lib/types';
import { clearAgentsCache } from '@/app/api/agents/route';

// PATCH /api/agents/by-name
// Lets an agent update itself by project+name without knowing its UUID.
// Body: { project, name, ...fields } — same fields as PATCH /api/agents/[id]
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { project, name, ...fields } = body;

  if (!project?.trim() || !name?.trim()) {
    return NextResponse.json({ detail: 'project and name are required' }, { status: 400 });
  }

  const existing = db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.project, project.trim()), eq(schema.agents.name, name.trim())))
    .get();

  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  if (fields.skillIds !== undefined) updates.skillIds = JSON.stringify(fields.skillIds);
  if (fields.model !== undefined) updates.model = fields.model;
  if (fields.prompt !== undefined) updates.prompt = fields.prompt;
  if (fields.schedule !== undefined) updates.schedule = fields.schedule || null;
  if (fields.runner !== undefined) updates.runner = fields.runner;
  if (fields.enabled !== undefined) updates.enabled = fields.enabled;

  db.update(schema.agents).set(updates).where(eq(schema.agents.id, existing.id)).run();
  clearAgentsCache();

  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, existing.id)).get();

  if (agent) {
    try {
      if (agent.schedule && agent.prompt && agent.enabled) {
        await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.runner, agent.project, agent.name);
      } else {
        await uninstallAgentSchedule(agent.id, agent.runner, agent.project, agent.name);
      }
    } catch (e: unknown) {
      console.error(`Failed to update schedule for agent ${agent.id}:`, errMsg(e));
    }
  }

  return NextResponse.json({ agent });
}
