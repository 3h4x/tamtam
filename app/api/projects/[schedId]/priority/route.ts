import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/auth';
import { getImproveConfig, writePriorityYaml, PRIORITY_ORDER } from '@/lib/scheduling';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ schedId: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { schedId } = await params;
  const body = await request.json();
  const priority = body.priority;
  if (!PRIORITY_ORDER.includes(priority)) {
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
  writePriorityYaml(cfg.project, cfg.scheduler, priority);
  return NextResponse.json({ status: 'ok' });
}
