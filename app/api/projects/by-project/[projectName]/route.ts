import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { clearProjectDataCache } from '@/lib/shared/project-data';
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

  clearProjectDataCache();

  if (hasArchived && body.archived) {
    // Drop any scheduled agent timers belonging to this project so the
    // archive takes effect without waiting for the next scheduler reload.
    const agents = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.project, projectName));
    for (const a of agents) await uninstallAgentSchedule(a.id);
  }

  return NextResponse.json({
    project: projectName,
    archived: hasArchived ? body.archived : !!row.archived,
    paused: hasPaused ? body.paused : !!row.paused,
  });
}
