import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { clearProjectDataCache } from '@/lib/shared/project-data';
import { refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';
import { uninstallAgentSchedule } from '@/lib/scheduling/agent-scheduler';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json().catch(() => ({})) as { archived?: unknown; paused?: unknown };

  const hasArchived = body.archived !== undefined;
  const hasPaused = body.paused !== undefined;

  if (!hasArchived && !hasPaused) {
    return NextResponse.json({ detail: 'archived or paused boolean required' }, { status: 400 });
  }
  if (hasArchived && typeof body.archived !== 'boolean') {
    return NextResponse.json({ detail: 'archived must be a boolean' }, { status: 400 });
  }
  if (hasPaused && typeof body.paused !== 'boolean') {
    return NextResponse.json({ detail: 'paused must be a boolean' }, { status: 400 });
  }

  const projectRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projectName))
    .limit(1);
  const row = projectRows[0] ?? null;
  if (!row) {
    return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  }

  const updates: { archived?: boolean; paused?: boolean } = {};
  if (hasArchived) updates.archived = body.archived as boolean;
  if (hasPaused) updates.paused = body.paused as boolean;

  await db.update(schema.projects)
    .set(updates)
    .where(eq(schema.projects.name, projectName));

  // Resuming clears any auto-pause reason so the inbox `project_paused` HITL
  // self-resolves (it only fires for a paused project WITH a recorded reason).
  if (hasPaused && body.paused === false) {
    const { clearPauseReason } = await import('@/lib/pipeline/pause-project');
    await clearPauseReason(projectName);
  }

  clearProjectDataCache();
  // isProjectPaused/isProjectArchived read from a separate 10s TTL cache. Prime
  // it synchronously so admission gates see the new state as soon as PATCH
  // returns.
  await refreshProjectsCacheSync();

  if (hasArchived && body.archived) {
    // Drop any scheduled agent timers belonging to this project so the
    // archive takes effect without waiting for the next scheduler reload.
    // Each uninstall is an independent graphile-worker mutation — running
    // them in parallel cuts the PATCH latency on projects with many
    // scheduled agents from O(N × per-call) to roughly per-call.
    const agents = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.project, projectName));
    await Promise.all(agents.map((a) => uninstallAgentSchedule(a.id)));
  }

  return NextResponse.json({
    project: projectName,
    archived: hasArchived ? body.archived : !!row.archived,
    paused: hasPaused ? body.paused : !!row.paused,
  });
}
