import { NextRequest, NextResponse } from 'next/server';
import { cancelAutomationQueueItem, type AutomationQueueKind } from '@/lib/workflows/automation-queue';
import { errMsg } from '@/lib/shared/types';

function isQueueKind(value: unknown): value is AutomationQueueKind {
  return value === 'pending_release' || value === 'queued_agent_run';
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { kind?: unknown; project?: unknown; id?: unknown };
  if (!isQueueKind(body.kind) || typeof body.project !== 'string' || body.project.trim() === '') {
    return NextResponse.json({ detail: 'kind and project are required' }, { status: 400 });
  }
  try {
    const cancelled = await cancelAutomationQueueItem({
      kind: body.kind,
      project: body.project,
      id: typeof body.id === 'string' || typeof body.id === 'number' ? body.id : undefined,
    });
    if (!cancelled) return NextResponse.json({ detail: 'queue item not found' }, { status: 404 });
    return NextResponse.json({ status: 'cancelled' });
  } catch (error) {
    console.error('[automation-queue] cancel failed:', error);
    return NextResponse.json({ detail: `Failed to cancel queue item: ${errMsg(error)}` }, { status: 500 });
  }
}
