import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json().catch(() => ({})) as {
    queue_if_blocked?: unknown;
    source_job_id?: unknown;
  };
  const opts = {
    queueIfBlocked: body.queue_if_blocked === true,
    sourceJobId: typeof body.source_job_id === 'string' ? body.source_job_id : undefined,
    // An explicit POST to this route is an operator-initiated release (the UI
    // Release button). Trust the operator's own uncommitted working tree the
    // same way an agent-triggered release does — committed commits are still
    // author-verified by the PR-branch gate.
    operatorInitiated: true,
  };
  // Every release routes through the Vercel Workflow scaffold. The workflow
  // body delegates to startRelease for pre-flight + first-step kickoff,
  // then dispatches the orchestrator to chain the rest. Awaiting the run's
  // returnValue lets the route surface 4xx/5xx from pre-flight checks the
  // same way a direct call would.
  let r;
  try {
    const { start } = await import('workflow/api');
    const { releaseWorkflow } = await import('@/lib/workflows/release');
    const run = await start(releaseWorkflow, [projectName, opts]);
    r = await run.returnValue;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail: `Release workflow failed: ${msg}` }, { status: 500 });
  }
  if (!r.ok) {
    const errorBody: { detail: string; blocking_job_id?: string } = { detail: r.detail };
    if (r.blockingJobId) errorBody.blocking_job_id = r.blockingJobId;
    return NextResponse.json(errorBody, { status: r.status });
  }
  if ('status' in r && r.status === 'queued') {
    return NextResponse.json({
      status: 'queued',
      message: r.message,
      blocking_job_id: r.blockingJobId,
    }, { status: 202 });
  }
  return NextResponse.json({
    status: 'started',
    step: r.step,
    job_id: r.jobId,
    release_job_id: r.releaseJobId,
    message: r.message,
  });
}
