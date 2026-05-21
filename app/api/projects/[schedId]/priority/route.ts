import { NextRequest, NextResponse } from 'next/server';
import { getImproveConfig, writePriorityYaml, PRIORITY_ORDER } from '@/lib/scheduling/scheduling';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ schedId: string }> }
) {
  const { schedId } = await params;
  let body: { priority?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: 'invalid JSON body' }, { status: 400 });
  }
  const priority = body.priority;
  if (typeof priority !== 'string' || !(PRIORITY_ORDER as readonly string[]).includes(priority)) {
    return NextResponse.json(
      { detail: `priority must be one of ${PRIORITY_ORDER.join(', ')}` },
      { status: 422 }
    );
  }
  const { projects } = getImproveConfig();
  const cfg = projects[schedId];
  if (!cfg) {
    return NextResponse.json({ detail: `project '${schedId}' not found` }, { status: 404 });
  }
  await writePriorityYaml(cfg.project, cfg.scheduler, priority);
  return NextResponse.json({ status: 'ok' });
}
