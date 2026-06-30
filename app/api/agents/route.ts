import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { installAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { errMsg } from '@/lib/shared/types';
import { getAllAgentsCached, clearAgentsCache, normalizeAgent } from '@/lib/agents/agents-cache';
import { findAgentNameConflict } from '@/lib/agents/agent-conflicts';
import { canonicalAgentNameKey, normalizeAgentNameInput } from '@/lib/agents/agent-name';
import { parseAgentRole, inferAgentRole } from '@/lib/agents/roles';
import { writeFileAgent, type FileAgent } from '@/lib/agents/tamtam-file-agents';
import { getFileAgentOverrideSync } from '@/lib/agents/file-agent-overrides';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { parseOptionalKnownModelInput } from '@/lib/agents/model-aliases';
import { parseOptionalAgentScheduleInput } from '@/lib/scheduling/agent-schedule';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { parsePrerequisiteCommandInput } from '@/lib/agents/prerequisites';
import { parseOptionalPermissionModeInput } from '@/lib/shared/config';
import { resolveAgentPrerequisiteCommandWithFileSkills } from '@/lib/agents/file-skill-prerequisites';
import { isBuiltInRecommendedAgent } from '@/lib/agents/recommended-agents';
import { loadAgentCronStates, getAllAgentLastAttempts } from '@/lib/scheduling/agent-cron-state';
import { getAllFileAgentsCached, getFileAgentsForProjectCached } from '@/lib/agents/file-agents-cache';

function withEffectivePrerequisite<T extends { project: string; skillIds: string[]; prerequisiteCommand?: string | null }>(
  agent: T,
): T {
  return {
    ...agent,
    prerequisiteCommand: resolveAgentPrerequisiteCommandWithFileSkills({
      project: agent.project,
      skillIds: agent.skillIds,
      prerequisiteCommand: agent.prerequisiteCommand,
    }),
  };
}

// File agents have no DB row, so their runtime autopilot state lives in the
// file-agent override. Surface it (as a JSON string, matching the DB column's
// shape) so the editor can show an active throttle/downgrade instead of the
// stale base schedule/model.
function fileAgentAutopilotJson(fa: FileAgent): string | null {
  const ap = getFileAgentOverrideSync(fa.project, fa.name)?.autopilotState;
  return ap ? JSON.stringify(ap) : null;
}

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get('project');
  const name = request.nextUrl.searchParams.get('name');
  // `?fields=summary` strips the heaviest fields (prompt, prerequisiteCommand,
  // docPaths, skillIds JSON) so list-view callers don't pull KBs of edit-only
  // data on every poll. It keeps lightweight list metadata such as source and
  // kind. Detail views (AgentsTab, edit modals) ask without it to receive the
  // full agent shape. Fetching a specific name implies edit.
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
      // Scan ONLY the requested project (cached 10s per project). Reusing the
      // all-projects cache here forced every `?project=X` cold miss to re-scan
      // ALL enabled projects' filesystems just to filter down to one — a
      // synchronous walk that blocks the event loop and, on a project-tab poll,
      // starves the ~12 sibling mount requests (6–9s tab loads). A per-project
      // scan is far cheaper now that getBranchContext is cached.
      const fileAgentsForProject = getFileAgentsForProjectCached(projPath, project);
      for (const fa of fileAgentsForProject) {
        if (name && fa.name !== name) continue;
        if (!dbKeys.has(`${fa.project}:${canonicalAgentNameKey(fa.name)}`)) normalized.push({ ...withEffectivePrerequisite(fa), autopilotState: fileAgentAutopilotJson(fa), fallbackEnabled: false });
      }
    }
  } else {
    // Unfiltered list: scan every enabled project so the projects table can
    // show file agents (the home page calls this without ?project). Cached
    // for 10 s to avoid filesystem hits on every request.
    for (const fa of getAllFileAgentsCached()) {
      if (name && fa.name !== name) continue;
      if (!dbKeys.has(`${fa.project}:${canonicalAgentNameKey(fa.name)}`)) normalized.push({ ...withEffectivePrerequisite(fa), autopilotState: fileAgentAutopilotJson(fa), fallbackEnabled: false });
    }
  }

  // Per-agent cron telemetry: actual next-fire run_at from the graphile
  // queue + the most recent skip/dispatch reason. The UI uses these to
  // render "Skipped 14m ago (jobs paused) — next fire in 1m" instead of
  // a stale "due now" derived from lastRunAt + interval.
  const [cronStates, lastAttempts] = await Promise.all([
    loadAgentCronStates(),
    Promise.resolve(getAllAgentLastAttempts()),
  ]);
  const annotate = <T extends { id: string }>(a: T) => {
    const cs = cronStates.get(a.id);
    const la = lastAttempts.get(a.id);
    return {
      ...a,
      cron: cs ? {
        nextFireMs: cs.nextFireMs,
        attempts: cs.attempts,
        isAvailable: cs.isAvailable,
        lockedAt: cs.lockedAt,
        lastError: cs.lastError,
      } : null,
      lastAttempt: la ? { at: la.at, reason: la.reason, status: la.status } : null,
    };
  };

  // `cron.nextFireMs` and `lastAttempt.at` are live state — caching this
  // response in the browser would re-introduce the "due now / 31m ago"
  // stale display we just fixed. Force fresh fetches on every poll.
  const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' };

  if (summaryOnly) {
    const summaryAgents = normalized.map(a => annotate({
      id: a.id,
      name: a.name,
      project: a.project,
      schedule: a.schedule ?? null,
      enabled: a.enabled,
      model: a.model,
      provider: a.provider ?? null,
      kind: 'kind' in a ? (a.kind as 'user' | 'system') : 'user',
      source: 'source' in a ? a.source : 'db',
    }));
    return NextResponse.json({ agents: summaryAgents }, { headers: noStoreHeaders });
  }

  return NextResponse.json({ agents: normalized.map(annotate) }, { headers: noStoreHeaders });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, project, skillIds, docPaths, model, prompt, schedule, enabled } = body;
  const provider = isCliProvider(body.provider) ? body.provider : null;

  if (!project?.trim()) {
    return NextResponse.json({ detail: 'project is required' }, { status: 400 });
  }
  if (body.kind && body.kind !== 'user') {
    return NextResponse.json({ detail: 'kind=system agents are auto-seeded by TamTam and cannot be created via API' }, { status: 400 });
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
    : resolveAgentPrerequisiteCommandWithFileSkills({
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
  const { mode: permissionMode, error: permissionModeError } = parseOptionalPermissionModeInput(body.permissionMode);
  if (permissionModeError) {
    return NextResponse.json({ detail: permissionModeError }, { status: 400 });
  }

  const now = Date.now() / 1000;
  const id = `agent-${Date.now()}`;
  const fallbackEnabled = typeof body.fallbackEnabled === 'boolean'
    ? body.fallbackEnabled
    : isBuiltInRecommendedAgent(agentName);
  const agent = {
    id,
    name: agentName,
    project: projectName,
    skillIds: JSON.stringify(skillIdsList),
    docPaths: JSON.stringify(docPaths || []),
    model: parsedModel ?? 'normal',
    prompt: prompt || '',
    schedule: parsedSchedule,
    enabled: enabled !== false,
    boostable: body.boostable !== false,
    provider,
    fallbackEnabled,
    prerequisiteCommand,
    permissionMode,
    kind: 'user',
    // Role: explicit choice wins; otherwise infer from name/skills/prompt
    // (token-free heuristic). Operator can override later in the editor.
    role: typeof body.role === 'string'
      ? parseAgentRole(body.role)
      : inferAgentRole({ name: agentName, skillIds: skillIdsList, prompt: prompt || '' }),
    autopilotState: null,
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
          enabled: agent.enabled,
          boostable: agent.boostable,
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
