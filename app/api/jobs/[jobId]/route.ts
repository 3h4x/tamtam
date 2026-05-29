import { NextRequest, NextResponse } from 'next/server';
import { getJob, jobToDict, readDisplayLog, readLog, readLogHead, probeJobStatus, updateJob } from '@/lib/jobs/job-storage';
import { extractFailureLogDetail } from '@/lib/jobs/failure-log-detail';
import {
  getJobCancellationSignal,
  requestJobCancellation,
  SAFE_PID_FLOOR,
  shouldSignalJobPid,
} from '@/lib/jobs/cancellation';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ detail: `job '${jobId}' not found` }, { status: 404 });
  }
  await probeJobStatus(job);
  // Recover session_id for runs that were killed before the CLI emitted its
  // `result` event. The spawn helper writes the launch command to the top of
  // the log; if it contains `--resume <uuid>`, that's the session this job
  // belonged to. Backfill into the row so subsequent reads (and the terminal
  // page's redirect) get the same answer without re-scanning the log.
  if (!job.sessionId && job.kind === 'run' && job.logPath) {
    const sid = extractResumeSessionId(readLogHead(job, 4096));
    if (sid) {
      job.sessionId = sid;
      updateJob(job);
    }
  }
  const data = jobToDict(job);
  // Release logs are aggregates of child output (plain text + NDJSON mixed).
  // readParsedLog silently drops every non-NDJSON line, which hides test
  // output / commit / push details. Serve the raw aggregate instead so
  // "open terminal on a release" shows the full pipeline output verbatim.
  data.log = job.kind === 'release' ? readLog(job) : readDisplayLog(job);
  if ((job.exitCode ?? 0) !== 0 && job.logPath) {
    const detail = extractFailureLogDetail(job.logPath, {
      missingDetail: 'log file missing',
    });
    if (detail) data.detail = detail;
  }
  return NextResponse.json(data);
}

const RESUME_RE = /--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
function extractResumeSessionId(logHead: string): string | null {
  const match = RESUME_RE.exec(logHead);
  return match ? match[1] : null;
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ detail: `job '${jobId}' not found` }, { status: 404 });
  }
  if (job.finishedAt !== null) {
    return NextResponse.json({ detail: 'job already finished' }, { status: 409 });
  }

  // Cooperative cancellation + process.kill cover every spawn pathway
  // TamTam uses.

  const hasCooperativeCancellation = job.kind === 'push'
    || job.kind === 'commit'
    || getJobCancellationSignal(job.id) !== null;

  if (hasCooperativeCancellation) {
    job.cancelRequestedExitCode = -2;
    const cancelled = await requestJobCancellation(job.id, 20_000);
    if (!cancelled && job.finishedAt === null) {
      return NextResponse.json(
        { detail: `Timed out waiting for ${job.kind} to stop cleanly` },
        { status: 409 },
      );
    }
  } else if (shouldSignalJobPid(job)) {
    try { process.kill(job.pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      try { process.kill(job.pid, 'SIGKILL'); } catch {}
    }, 2000);
  } else if (job.pid > 0 && job.pid <= SAFE_PID_FLOOR) {
    console.warn(`[jobs] refusing to signal suspicious pid=${job.pid} for ${job.id} (${job.kind})`);
  }

  if (job.finishedAt === null) {
    job.exitCode = -2;
    job.finishedAt = Date.now() / 1000;
    updateJob(job);
  }

  // Propagate cancellation to the workflow runtime when the job was launched
  // by a durable workflow (signalled by `workflowRunId` on contextMeta).
  // Without this, the workflow_runs row stays "completed" even though the CLI
  // was killed — making restart-replay or operator inspection misleading.
  try {
    const meta = JSON.parse(job.contextMeta || '{}');
    const workflowRunId = typeof meta.workflowRunId === 'string' ? meta.workflowRunId : null;
    if (workflowRunId) {
      const { getRun } = await import('workflow/api');
      await getRun(workflowRunId).cancel();
    }
  } catch (e) {
    console.warn(`[jobs] workflow cancel for ${job.id} failed:`, e instanceof Error ? e.message : String(e));
  }

  return NextResponse.json({ status: 'cancelled' });
}
