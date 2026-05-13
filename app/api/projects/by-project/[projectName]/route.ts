import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { clearProjectDataCache } from '@/lib/shared/project-data';
import { removeAgentSchedule } from '@/lib/scheduling/internal-scheduler';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json().catch(() => ({})) as { archived?: unknown };

  if (typeof body.archived !== 'boolean') {
    return NextResponse.json({ detail: 'archived must be a boolean' }, { status: 400 });
  }

  const row = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projectName))
    .get();
  if (!row) {
    return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  }

  db.update(schema.projects)
    .set({ archived: body.archived })
    .where(eq(schema.projects.name, projectName))
    .run();

  clearProjectDataCache();

  if (body.archived) {
    // Drop any scheduled agent timers belonging to this project so the
    // archive takes effect without waiting for the next scheduler reload.
    const agents = db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.project, projectName))
      .all();
    for (const a of agents) removeAgentSchedule(a.id);
  }

  return NextResponse.json({ project: projectName, archived: body.archived });
}
