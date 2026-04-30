import { NextRequest, NextResponse } from 'next/server';
import { getJob, jobToDict, readParsedLog, readLog, probeJobStatus, updateJob } from '@/lib/jobs/job-storage';
import { exec } from '@/lib/shared/shell';

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
  data.log = job.kind === 'release' ? readLog(job) : readParsedLog(job);
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

  // Try pm2 stop first (for Claude/pm2 jobs)
  try {
    await exec('pm2', ['stop', jobId, '--silent'], { timeout: 5000 });
    await exec('pm2', ['delete', jobId, '--silent'], { timeout: 5000 });
  } catch {}

  // Kill by PID as fallback
  if (job.pid > 0) {
    try { process.kill(job.pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      try { process.kill(job.pid, 'SIGKILL'); } catch {}
    }, 2000);
  }

  job.exitCode = -2;
  job.finishedAt = Date.now() / 1000;
  updateJob(job);

  return NextResponse.json({ status: 'cancelled' });
}
