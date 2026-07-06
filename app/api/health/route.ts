import { NextRequest, NextResponse } from 'next/server';
import { getReadinessReport, type ReadinessReport } from '@/lib/shared/readiness';
import { swrGet, type SwrStore } from '@/lib/shared/swr-cache';

// The deep readiness report (`?deep=1`) fans out to child-process probes —
// `gh auth status`, `pm2 --version`, a `bash -lc` command probe, per-provider
// binary lookups — plus per-provider quota fetches. That is several process
// spawns + network calls per call. The monitoring page polls it on mount AND
// every 60s, and multiple open tabs / the mount racing other requests multiply
// it, so under load a single probe ballooned to ~5s and starved the event loop
// (which in turn inflated the sibling /api/inbox + /api/monitoring calls on the
// same page). A health snapshot tolerates a few seconds of staleness, so serve
// the deep report stale-while-revalidate: only the first read per TTL window
// actually spawns the probes; later reads return the last value immediately and
// refresh in the background. Pinned to globalThis because Next.js duplicates
// route modules across bundle realms.
declare global {
  var __tamtamReadinessCache: Map<string, { value: ReadinessReport; time: number }> | undefined;
  var __tamtamReadinessInflight: Map<string, Promise<ReadinessReport>> | undefined;
}
const READINESS_TTL_MS = 15_000;

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get('deep') === '1') {
    const store: SwrStore<ReadinessReport> = {
      cache: (globalThis.__tamtamReadinessCache ??= new Map()),
      inflight: (globalThis.__tamtamReadinessInflight ??= new Map()),
    };
    const report = await swrGet(store, 'deep', READINESS_TTL_MS, () => getReadinessReport());
    return NextResponse.json({ status: report.ok ? 'ok' : 'degraded', ...report }, { status: report.ok ? 200 : 503 });
  }
  // Shallow liveness probe stays uncached: always instant, always fresh — the
  // rebuild/recovery flows and external monitors depend on it reflecting reality
  // right now, not a cached snapshot.
  return NextResponse.json({ status: 'ok' });
}
