import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { installAgentSchedule } from '@/lib/agent-scheduler';
import { errMsg } from '@/lib/types';

const AGENTS_CACHE_TTL = 10; // seconds
let _agentsCache: { agents: typeof schema.agents.$inferSelect[]; time: number } | null = null;

function getAllAgentsCached() {
  const now = Date.now() / 1000;
  if (_agentsCache && now - _agentsCache.time < AGENTS_CACHE_TTL) return _agentsCache.agents;
  const agents = db.select().from(schema.agents).all();
  _agentsCache = { agents, time: now };
  return agents;
}

export function clearAgentsCache() {
  _agentsCache = null;
}

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  const agents = getAllAgentsCached();
  const result = project ? agents.filter(a => a.project === project) : agents;
  return NextResponse.json({ agents: result });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, project, skillIds, model, prompt, schedule, runner } = body;

  if (!name?.trim()) {
    return NextResponse.json({ detail: 'name is required' }, { status: 400 });
  }
  if (!project?.trim()) {
    return NextResponse.json({ detail: 'project is required' }, { status: 400 });
  }

  const now = Date.now() / 1000;
  const id = `agent-${Date.now()}`;
  const agent = {
    id,
    name: name.trim(),
    project: project.trim(),
    skillIds: JSON.stringify(skillIds || []),
    model: model || 'sonnet',
    prompt: prompt || '',
    schedule: schedule || null,
    runner: runner || 'pm2',
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.agents).values(agent).run();
  clearAgentsCache();

  // Install schedule if configured (uses pm2 or launchctl based on runner)
  if (agent.schedule && agent.prompt) {
    try {
      await installAgentSchedule(id, agent.schedule, agent.prompt, agent.runner, agent.project, agent.name);
    } catch (e: unknown) {
      console.error(`Failed to install schedule for agent ${id}:`, errMsg(e));
    }
  }

  return NextResponse.json({ agent }, { status: 201 });
}
