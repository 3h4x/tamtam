import { NextResponse } from 'next/server';
import { resumeStuckRelease } from '@/lib/pipeline/resume-stuck-release';

// POST /api/projects/by-project/<projectName>/release/<releaseId>/resume
// Manually resume a release whose chain stopped at a non-terminal step
// (test/fix/review/commit) but was already marked finished. The same logic
// runs automatically on a 5-minute background ticker via
// `autoResumeStuckReleases`; this endpoint is the on-demand handle.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ projectName: string; releaseId: string }> },
) {
  const { projectName, releaseId } = await params;
  const result = await resumeStuckRelease(projectName, releaseId);
  if (!result.ok) {
    const status =
      result.status === 'not_found' ? 404 :
      result.status === 'still_active' ? 409 :
      result.status === 'not_stuck' ? 409 :
      result.status === 'job_busy' ? 409 :
      result.status === 'lock_busy' ? 409 :
      500;
    const body: Record<string, unknown> = { detail: result.detail };
    if (result.blockingJobId) body.blocking_job_id = result.blockingJobId;
    return NextResponse.json(body, { status });
  }
  return NextResponse.json({
    status: 'resumed',
    release: releaseId,
    project: projectName,
    resumedFrom: result.resumedFrom,
  });
}
