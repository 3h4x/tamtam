import { NextResponse } from 'next/server';
import { computeReleasePlan } from '@/lib/pipeline/release-plan';

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
    const plan = await computeReleasePlan(projectName);
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
