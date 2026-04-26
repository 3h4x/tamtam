import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { installAgentSchedule } from '@/lib/agent-scheduler';
import { errMsg } from '@/lib/types';
import { getAllAgentsCached, clearAgentsCache, normalizeAgent } from '@/lib/agents-cache';
import { scanFileAgents } from '@/lib/tamtam-file-agents';
import { resolveProjectPath } from '@/lib/project-data';

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  const name = request.nextUrl.searchParams.get('name');
  const agents = getAllAgentsCached();
  let result = project ? agents.filter(a => a.project === project) : agents;
  if (name) result = result.filter(a => a.name === name);

  const normalized = result.map(normalizeAgent);

  // Merge file-based agents when filtering by project. DB agents take precedence
  // over file agents with the same name.
  if (project) {
    const projPath = resolveProjectPath(project);
    if (projPath) {
      const dbNames = new Set(normalized.map(a => a.name));
      const fileAgents = scanFileAgents(projPath, project);
      for (const fa of fileAgents) {
        if (!dbNames.has(fa.name)) {
          normalized.push(fa);
        }
      }
    }
  }

  return NextResponse.json({ agents: normalized });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, project, skillIds, model, prompt, schedule, runner, enabled } = body;

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
    enabled: enabled !== false,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.agents).values(agent).run();
  clearAgentsCache();

  // Install schedule if configured (uses pm2 or launchctl based on runner).
  // Runs only need either a prompt or skills to produce meaningful output.
  const hasSkills = (skillIds || []).length > 0;
  if (agent.schedule && agent.enabled && (agent.prompt || hasSkills)) {
    try {
      await installAgentSchedule(id, agent.schedule, agent.prompt, agent.runner, agent.project, agent.name);
    } catch (e: unknown) {
      console.error(`Failed to install schedule for agent ${id}:`, errMsg(e));
    }
  }

  return NextResponse.json({ agent: normalizeAgent(agent) }, { status: 201 });
}
