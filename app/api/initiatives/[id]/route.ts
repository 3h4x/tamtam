import { NextRequest, NextResponse } from 'next/server';
import {
  setPinned,
  setStatus,
  getInitiativeById,
  type InitiativeStatus,
} from '@/lib/orchestrator/initiatives-store';

type Action = 'promote' | 'unpromote' | 'reject' | 'restore';
const ACTIONS: Action[] = ['promote', 'unpromote', 'reject', 'restore'];
const CURATABLE_STATUSES = new Set<InitiativeStatus>(['proposed', 'queued']);

function actionAllowed(action: Action, status: InitiativeStatus): boolean {
  if (action === 'restore') return status === 'rejected';
  return CURATABLE_STATUSES.has(status);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id: idStr } = await ctx.params;
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = body.action as Action | undefined;
    if (!action || !ACTIONS.includes(action)) {
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
    const row = await getInitiativeById(id);
    if (!row) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (!actionAllowed(action, row.status)) {
      return NextResponse.json(
        { error: `action ${action} is not valid for ${row.status} initiatives` },
        { status: 409 },
      );
    }
    switch (action) {
      case 'promote': await setPinned(id, Date.now()); break;
      case 'unpromote': await setPinned(id, null); break;
      case 'reject': await setStatus(id, 'rejected'); break;
      case 'restore':
        await setStatus(id, 'queued', { releaseId: null, cooldownUntil: null });
        await setPinned(id, null);
        break;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[api/initiatives/[id]] failed:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
