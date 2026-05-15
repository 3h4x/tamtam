import { NextRequest, NextResponse } from 'next/server';
import { getJob, jobToDict, readDisplayLog, readLog, probeJobStatus, updateJob } from '@/lib/jobs/job-storage';
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
  const data = jobToDict(job);
  // Release logs are aggregates of child output (plain text + NDJSON mixed).
  // readParsedLog silently drops every non-NDJSON line, which hides test
  // output / commit / push details. Serve the raw aggregate instead so
  // "open terminal on a release" shows the full pipeline output verbatim.
  data.log = job.kind === 'release' ? readLog(job) : readDisplayLog(job);
  return NextResponse.json(data);
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

  // (Per-job PM2 entries were retired — no `pm2 stop` / `pm2 delete` is
  // needed before cancellation. Cooperative cancellation + process.kill
  // cover every spawn pathway TamTam still uses.)

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

  return NextResponse.json({ status: 'cancelled' });
}
