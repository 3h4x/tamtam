import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/agent-scheduler';
import { errMsg } from '@/lib/types';
import { clearAgentsCache } from '@/app/api/agents/route';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!agent) return NextResponse.json({ detail: 'not found' }, { status: 404 });
  return NextResponse.json({ agent });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const existing = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!existing) return NextResponse.json({ detail: 'not found' }, { status: 404 });

  const body = await request.json();
  const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.skillIds !== undefined) updates.skillIds = JSON.stringify(body.skillIds);
  if (body.model !== undefined) updates.model = body.model;
  if (body.prompt !== undefined) updates.prompt = body.prompt;
  if (body.schedule !== undefined) updates.schedule = body.schedule || null;
  if (body.runner !== undefined) updates.runner = body.runner;
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  db.update(schema.agents).set(updates).where(eq(schema.agents.id, agentId)).run();
  clearAgentsCache();
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();

  // Update schedule (uses pm2 or launchctl based on runner)
  if (agent) {
    try {
      if (agent.schedule && agent.prompt && agent.enabled) {
        await installAgentSchedule(agentId, agent.schedule, agent.prompt, agent.runner, agent.project, agent.name);
      } else {
        await uninstallAgentSchedule(agentId, agent.runner, agent.project, agent.name);
      }
    } catch (e: unknown) {
      console.error(`Failed to update schedule for agent ${agentId}:`, errMsg(e));
    }
  }

  return NextResponse.json({ agent });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  // Uninstall schedule before deleting
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  try {
    await uninstallAgentSchedule(agentId, agent?.runner || 'pm2', agent?.project, agent?.name);
  } catch (e: unknown) {
    console.error(`Failed to uninstall schedule for agent ${agentId}:`, errMsg(e));
  }

  db.delete(schema.agents).where(eq(schema.agents.id, agentId)).run();
  clearAgentsCache();
  return NextResponse.json({ status: 'deleted' });
}
