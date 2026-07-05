import { NextResponse } from 'next/server';
import { computeReleasePlan, type ReleasePlan } from '@/lib/pipeline/release-plan';
import { swrGet, type SwrStore } from '@/lib/shared/swr-cache';

// `computeReleasePlan` does ~5–6 read-only git spawns + an fs test-probe + DB
// reads, so under host contention this dry-run took multiple seconds. The
// ReleasePlanPanel re-fetches it on every refreshKey change (branch / changes /
// verdict / config) with a plain fetch (no client memo), so a full compute ran
// on each. Cache the plan per project with a short TTL and single-flight cold
// misses so the refetch storm collapses to one compute. Stale-while-revalidate:
// once a plan exists, reads return it immediately and refresh in the background,
// so only the first-ever load per project is slow. The plan is side-effect-free
// and only previewed, so brief staleness is fine — the panel re-fetches as
// inputs settle, and the real Release re-checks at launch. Pinned to globalThis
// because Next.js duplicates route modules across bundle realms; TTL-only
// (read-only endpoint — no mutation to invalidate from).
declare global {
  var __tamtamReleasePlanCache: Map<string, { value: ReleasePlan; time: number }> | undefined;
  var __tamtamReleasePlanInflight: Map<string, Promise<ReleasePlan>> | undefined;
}
const RELEASE_PLAN_TTL_MS = 5_000;

function cachedReleasePlan(projectName: string): Promise<ReleasePlan> {
  const store: SwrStore<ReleasePlan> = {
    cache: (globalThis.__tamtamReleasePlanCache ??= new Map()),
    inflight: (globalThis.__tamtamReleasePlanInflight ??= new Map()),
  };
  return swrGet(store, projectName, RELEASE_PLAN_TTL_MS, () => computeReleasePlan(projectName));
}

// Side-effect-free dry-run of the Release button. Returns the ordered steps the
// release pipeline would execute for the project's current branch/state/config
// without running any of them — no git writes, no job creation, no PM2 start,
// no GitHub mutation, no webhook send. Mirrors the same decision helpers as
// startRelease so the plan stays in sync with real behavior.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;
  try {
    const plan = await cachedReleasePlan(projectName);
    if (plan.blockers.some((b) => b.code === 'not_found')) {
      return NextResponse.json({ detail: 'project not found' }, { status: 404 });
    }
    return NextResponse.json(plan);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[release/plan] failed for ${projectName}:`, detail);
    return NextResponse.json({ detail: `Failed to compute release plan: ${detail}` }, { status: 500 });
  }
}
