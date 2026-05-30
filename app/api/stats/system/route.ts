import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSystemMetrics, getRecentSystemMetrics } from '@/lib/shared/system-metrics';

// Live + recent host resource samples (CPU/mem/load/disk), one per minute.
// The in-memory ring holds ~3h; the full ~7-day history lives in
// data/system-metrics.jsonl for offline analysis.
export async function GET(request: NextRequest) {
  const raw = parseInt(request.nextUrl.searchParams.get('limit') ?? '180', 10);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 1440) : 180;
  return NextResponse.json({
    current: getCurrentSystemMetrics(),
    samples: getRecentSystemMetrics(limit),
  });
}
