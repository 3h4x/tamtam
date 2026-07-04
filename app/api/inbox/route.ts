import { NextResponse } from 'next/server';
import { listInboxSignals, countInboxSignals } from '@/lib/workflows/inbox';

// Cross-project triage feed. Aggregates actionable signals from the
// project-data cache, the jobs cache, the automation queue, and the gh issues
// cache. Read-only — every action button on the client calls an existing
// per-project endpoint (release / review / fix-ci / merge / automation retry).
//
// `?project=<name>` narrows the feed to a single project's signals (with counts
// recomputed for that subset). The project page uses this to surface the same
// HITL/blocked decisions inline, so an operator who opens a blocked project
// sees the actionable reason there instead of only in the cross-project inbox.
export async function GET(request: Request) {
  try {
    const { signals, counts } = await listInboxSignals();
    const project = new URL(request.url).searchParams.get('project');
    if (project) {
      const filtered = signals.filter((s) => s.project === project);
      return NextResponse.json({ signals: filtered, counts: countInboxSignals(filtered) });
    }
    return NextResponse.json({ signals, counts });
  } catch (error) {
    console.error('[api/inbox] failed to build inbox feed:', error);
    return NextResponse.json({ detail: 'Failed to build inbox feed' }, { status: 500 });
  }
}
