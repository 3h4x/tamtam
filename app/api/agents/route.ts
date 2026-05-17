import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { installAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { errMsg } from '@/lib/shared/types';
import { getAllAgentsCached, clearAgentsCache, normalizeAgent } from '@/lib/agents/agents-cache';
import { findAgentNameConflict } from '@/lib/agents/agent-conflicts';
import { canonicalAgentNameKey, normalizeAgentNameInput } from '@/lib/agents/agent-name';
import { scanFileAgents, writeFileAgent, type FileAgent } from '@/lib/agents/tamtam-file-agents';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { listEnabledProjects } from '@/lib/shared/enabled-projects';
import { parseOptionalKnownModelInput } from '@/lib/agents/model-aliases';
import { parseOptionalAgentScheduleInput } from '@/lib/scheduling/agent-schedule';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { parsePrerequisiteCommandInput, resolveAgentPrerequisiteCommand } from '@/lib/agents/issue-cruncher';

const ALL_FILE_AGENTS_TTL_MS = 10_000;
let _allFileAgentsCache: { agents: FileAgent[]; time: number } | null = null;

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

function getAllFileAgentsCached(): FileAgent[] {
  const now = Date.now();
  if (_allFileAgentsCache && now - _allFileAgentsCache.time < ALL_FILE_AGENTS_TTL_MS) {
    return _allFileAgentsCache.agents;
  }
  const out: FileAgent[] = [];
  for (const p of listEnabledProjects()) {
    try {
      for (const fa of scanFileAgents(p.path, p.name)) out.push(fa);
    } catch { /* skip */ }
  }
  _allFileAgentsCache = { agents: out, time: now };
  return out;
}

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  const name = request.nextUrl.searchParams.get('name');
  // `?fields=summary` strips the heaviest fields (prompt, prerequisiteCommand,
  // docPaths, skillIds JSON) so list-view callers don't pull KBs of edit-only
  // data on every poll. Detail views (AgentsTab, edit modals) ask without it
  // to receive the full agent shape. Fetching a specific name implies edit.
  const summaryOnly = request.nextUrl.searchParams.get('fields') === 'summary' && !name;
  const agents = getAllAgentsCached();
  let result = project ? agents.filter(a => a.project === project) : agents;
  if (name) result = result.filter(a => a.name === name);

  const normalized = result.map(normalizeAgent);

  // Merge file-based agents (.tamtam/agents/*.md). DB agents take precedence
  // over file agents with the same project+name.
  const dbKeys = new Set(normalized.map(a => `${a.project}:${canonicalAgentNameKey(a.name)}`));
  if (project) {
    const projPath = resolveProjectPath(project);
    if (projPath) {
      for (const fa of scanFileAgents(projPath, project)) {
        if (name && fa.name !== name) continue;
        if (!dbKeys.has(`${fa.project}:${canonicalAgentNameKey(fa.name)}`)) normalized.push(withEffectivePrerequisite(fa));
      }
    }
  } else {
    // Unfiltered list: scan every enabled project so the projects table can
    // show file agents (the home page calls this without ?project). Cached
    // for 10 s to avoid filesystem hits on every request.
    for (const fa of getAllFileAgentsCached()) {
      if (name && fa.name !== name) continue;
      if (!dbKeys.has(`${fa.project}:${canonicalAgentNameKey(fa.name)}`)) normalized.push(withEffectivePrerequisite(fa));
    }
  }

  if (summaryOnly) {
    const summaryAgents = normalized.map(a => ({
      id: a.id,
      name: a.name,
      project: a.project,
      schedule: a.schedule ?? null,
      enabled: a.enabled,
      model: a.model,
      runner: a.runner,
      provider: a.provider ?? null,
      source: 'source' in a ? a.source : 'db',
    }));
    return NextResponse.json({ agents: summaryAgents });
  }

  return NextResponse.json({ agents: normalized });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, project, skillIds, docPaths, model, prompt, schedule, runner, enabled } = body;
  const provider = isCliProvider(body.provider) ? body.provider : null;

  if (!project?.trim()) {
    return NextResponse.json({ detail: 'project is required' }, { status: 400 });
  }
  const parsedName = normalizeAgentNameInput(name);
  if (parsedName.error) {
    return NextResponse.json({ detail: parsedName.error }, { status: 400 });
  }
  const projectName = project.trim();
  const agentName = parsedName.name!;
  const conflict = await findAgentNameConflict(projectName, agentName);
  if (conflict) {
    return NextResponse.json({ detail: `agent '${agentName}' already exists for ${projectName}` }, { status: 409 });
  }
  const skillIdsList = skillIds || [];
  const parsedPrerequisiteCommand = parsePrerequisiteCommandInput(body.prerequisiteCommand);
  const prerequisiteCommand = parsedPrerequisiteCommand !== undefined
    ? parsedPrerequisiteCommand
    : resolveAgentPrerequisiteCommand({
        project: projectName,
        skillIds: skillIdsList,
        prerequisiteCommand: null,
      });
  const { model: parsedModel, error: modelError } = parseOptionalKnownModelInput(model, 'normal');
  if (modelError) {
    return NextResponse.json({ detail: modelError }, { status: 400 });
  }
  const { schedule: parsedSchedule, error: scheduleError } = parseOptionalAgentScheduleInput(schedule);
  if (scheduleError) {
    return NextResponse.json({ detail: scheduleError }, { status: 400 });
  }

  const now = Date.now() / 1000;
  const id = `agent-${Date.now()}`;
  const agent = {
    id,
    name: agentName,
    project: projectName,
    skillIds: JSON.stringify(skillIdsList),
    docPaths: JSON.stringify(docPaths || []),
    model: parsedModel ?? 'normal',
    prompt: prompt || '',
    schedule: parsedSchedule,
    runner: runner || 'pm2',
    enabled: enabled !== false,
    provider,
    prerequisiteCommand,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(schema.agents).values(agent).execute();
  clearAgentsCache();

  // Sync to .tamtam/agents/<name>.md for version control
  const projPath = resolveProjectPath(agent.project);
  if (projPath) {
    try {
        writeFileAgent(projPath, agent.project, agent.name, {
          prompt: agent.prompt,
          model: agent.model,
          schedule: agent.schedule,
          skillIds: skillIdsList,
          runner: agent.runner,
          enabled: agent.enabled,
          provider: agent.provider,
          prerequisiteCommand: agent.prerequisiteCommand,
        });
    } catch { /* non-fatal */ }
  }

  // Install schedule if configured (fired by graphile-worker cron pool).
  // Runs only need either a prompt or skills to produce meaningful output.
  const hasSkills = (skillIds || []).length > 0;
  if (agent.schedule && agent.enabled && (agent.prompt || hasSkills)) {
    try {
      await installAgentSchedule(id, agent.schedule, agent.prompt, agent.project, agent.name);
    } catch (e: unknown) {
      console.error(`Failed to install schedule for agent ${id}:`, errMsg(e));
    }
  }

  return NextResponse.json({ agent: normalizeAgent(agent) }, { status: 201 });
}
