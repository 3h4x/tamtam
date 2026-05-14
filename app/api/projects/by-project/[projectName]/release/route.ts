import { NextRequest, NextResponse } from 'next/server';
import { startRelease } from '@/lib/pipeline/start-release';

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
  };
  // Opt-in: route through the Vercel Workflow scaffold. Same outcome today
  // (workflow body just delegates to startRelease), but every release gets
  // a workflow_runs row for observability and the body is the seam where
  // the pipeline state machine will eventually live.
  let r;
  if (process.env.TAMTAM_RELEASE_WORKFLOW === '1') {
    try {
      const { start } = await import('workflow/api');
      const { releaseWorkflow } = await import('@/lib/workflows/release');
      // start() returns a Run handle once the workflow has been enqueued; we
      // await the run's result so the route still surfaces 4xx/5xx from
      // pre-flight checks the same way the direct call does.
      const run = await start(releaseWorkflow, [projectName, opts]);
      r = await run.returnValue;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ detail: `Release workflow failed: ${msg}` }, { status: 500 });
    }
  } else {
    r = await startRelease(projectName, opts);
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
