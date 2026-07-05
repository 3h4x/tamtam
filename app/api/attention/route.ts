import { NextResponse } from 'next/server';
import { listInboxSignals } from '@/lib/workflows/inbox';
import { listAllOpenRecommendations } from '@/lib/recommendations/recommendations';
import { recommendationToItem, mergeAttention } from '@/lib/attention/map';

// Unified Inbox feed: the derived inbox signals (repo shippability) interleaved
// with the open recommendations (agent quality), mapped into one AttentionItem
// shape and sorted red → yellow → green. Read-only; action buttons hit the
// existing per-project inbox/recommendation endpoints.
//
//   GET /api/attention            → { items, counts } across every project
//   GET /api/attention?project=x  → narrowed to one project (per-project banner)
export async function GET(request: Request) {
  const project = new URL(request.url).searchParams.get('project');
  try {
    const [{ signals }, recs] = await Promise.all([
      listInboxSignals(),
      listAllOpenRecommendations(),
    ]);
    const sigs = project ? signals.filter((s) => s.project === project) : signals;
    const recRows = project ? recs.filter((r) => r.project === project) : recs;
    const { items, counts } = mergeAttention(sigs, recRows.map(recommendationToItem));
    return NextResponse.json({ items, counts });
  } catch (error) {
    console.error('[api/attention] failed to build feed', error);
    return NextResponse.json({ detail: 'Failed to build attention feed' }, { status: 500 });
  }
}
