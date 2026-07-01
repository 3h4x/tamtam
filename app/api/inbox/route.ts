import { NextResponse } from 'next/server';
import { listInboxSignals } from '@/lib/workflows/inbox';

// Cross-project triage feed. Aggregates actionable signals from the
// project-data cache, the jobs cache, the automation queue, and the gh issues
// cache. Read-only — every action button on the client calls an existing
// per-project endpoint (release / review / fix-ci / merge / automation retry).
export async function GET() {
  try {
    const { signals, counts } = await listInboxSignals();
    return NextResponse.json({ signals, counts });
  } catch (error) {
    console.error('[api/inbox] failed to build inbox feed:', error);
    return NextResponse.json({ detail: 'Failed to build inbox feed' }, { status: 500 });
  }
}
