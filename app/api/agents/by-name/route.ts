import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { errMsg } from '@/lib/shared/types';
import { clearAgentsCache, normalizeAgent } from '@/lib/agents/agents-cache';
import { loadFileAgent, writeFileAgent } from '@/lib/agents/tamtam-file-agents';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { parseOptionalKnownModelInput } from '@/lib/agents/model-aliases';
import { parseOptionalAgentScheduleInput } from '@/lib/scheduling/agent-schedule';
import { isCliProvider } from '@/lib/usage/cli-providers';

// PATCH /api/agents/by-name
// Lets an agent update itself by project+name without knowing its UUID.
// Works for both DB agents and file-based agents (.tamtam/agents/*.md).
// Body: { project, name, ...fields } — same fields as PATCH /api/agents/[id]
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { project, name, ...fields } = body;
  const provider = fields.provider === null ? null : (isCliProvider(fields.provider) ? fields.provider : undefined);

  if (!project?.trim() || !name?.trim()) {
    return NextResponse.json({ detail: 'project and name are required' }, { status: 400 });
  }
  const { model: parsedModel, error: modelError } = parseOptionalKnownModelInput(fields.model, 'normal');
  if (modelError) return NextResponse.json({ detail: modelError }, { status: 400 });
  const parsedSchedule = fields.schedule !== undefined
    ? parseOptionalAgentScheduleInput(fields.schedule)
    : { schedule: undefined, error: null };
  if (parsedSchedule.error) return NextResponse.json({ detail: parsedSchedule.error }, { status: 400 });

  // Try DB agent first
  const existing = db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.project, project.trim()), eq(schema.agents.name, name.trim())))
    .get();

  if (existing) {
    const updates: Record<string, unknown> = { updatedAt: Date.now() / 1000 };
    if (fields.skillIds !== undefined) updates.skillIds = JSON.stringify(fields.skillIds);
    if (fields.model !== undefined) updates.model = parsedModel ?? 'normal';
    if (fields.prompt !== undefined) updates.prompt = fields.prompt;
    if (fields.schedule !== undefined) updates.schedule = parsedSchedule.schedule;
    if (fields.runner !== undefined) updates.runner = fields.runner;
    if (fields.enabled !== undefined) updates.enabled = fields.enabled;
    if (provider !== undefined) updates.provider = provider;

    db.update(schema.agents).set(updates).where(eq(schema.agents.id, existing.id)).run();
    clearAgentsCache();

    const agent = db.select().from(schema.agents).where(eq(schema.agents.id, existing.id)).get();

    if (agent) {
      // Sync to .tamtam/agents/<name>.md for version control
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
            provider: agent.provider,
          });
        } catch { /* non-fatal */ }
      }
      try {
        const hasSkills = JSON.parse(agent.skillIds || '[]').length > 0;
        if (agent.schedule && agent.enabled && (agent.prompt || hasSkills)) {
          await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.runner, agent.project, agent.name);
        } else {
          await uninstallAgentSchedule(agent.id, agent.runner, agent.project, agent.name);
        }
      } catch (e: unknown) {
        console.error(`Failed to update schedule for agent ${agent.id}:`, errMsg(e));
      }
    }

    return NextResponse.json({ agent: agent ? normalizeAgent(agent) : null });
  }

  // Fall back to file agent
  const projPath = resolveProjectPath(project.trim());
  if (projPath) {
    const fileAgent = loadFileAgent(projPath, project.trim(), name.trim());
    if (fileAgent) {
      try {
        const updated = writeFileAgent(projPath, project.trim(), name.trim(), {
          prompt: fields.prompt,
          model: parsedModel ?? undefined,
          schedule: fields.schedule !== undefined ? parsedSchedule.schedule : undefined,
          skillIds: fields.skillIds,
          runner: fields.runner,
          enabled: fields.enabled,
          provider,
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
  }

  return NextResponse.json({ detail: 'not found' }, { status: 404 });
}
