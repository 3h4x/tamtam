import { NextRequest, NextResponse } from 'next/server';
import { getLock, releaseLock } from '@/lib/pipeline-lock';
import { getJob, listJobs, updateJob } from '@/lib/job-storage';
import { exec } from '@/lib/shell';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const lock = getLock(projectName);
  if (!lock) {
    return NextResponse.json({ status: 'no_pipeline', detail: 'no active pipeline lock' }, { status: 200 });
  }

  const releaseJob = getJob(lock.lockedByJobId);
  if (!releaseJob || releaseJob.kind !== 'release' || releaseJob.finishedAt !== null) {
    // Lock exists but release is already done — just clean up the lock
    releaseLock(projectName, lock.lockedByJobId);
    return NextResponse.json({ status: 'no_pipeline', detail: 'release already finished' }, { status: 200 });
  }

  const now = Date.now() / 1000;

  // Mark the release job as aborted so completion hooks short-circuit
  releaseJob.abortedAt = now;
  releaseJob.finishedAt = now;
  releaseJob.exitCode = -3;
  updateJob(releaseJob);
  if (releaseJob.logPath) {
    try {
      const { appendFileSync } = await import('fs');
      appendFileSync(releaseJob.logPath, `\n# release aborted by user — ${new Date().toISOString()}\n`);
    } catch {}
  }

  // Find and kill the currently-running pipeline step job for this release
  const runningStep = listJobs().find(
    j => j.releaseId === releaseJob.id && j.finishedAt === null && j.kind !== 'release'
  );

  if (runningStep) {
    // Try pm2 stop first
    try {
      await exec('pm2', ['stop', runningStep.id, '--silent'], { timeout: 5000 });
      await exec('pm2', ['delete', runningStep.id, '--silent'], { timeout: 5000 });
    } catch {}

    // Kill by PID as fallback
    if (runningStep.pid > 0) {
      try { process.kill(runningStep.pid, 'SIGTERM'); } catch {}
      setTimeout(() => {
        try { process.kill(runningStep.pid, 'SIGKILL'); } catch {}
      }, 2000);
    }

    runningStep.abortedAt = now;
    runningStep.finishedAt = now;
    runningStep.exitCode = -3;
    updateJob(runningStep);
  }

  // Always release the pipeline lock
  releaseLock(projectName, lock.lockedByJobId);

  // Fire-and-forget notification
  try {
    const { notify } = await import('@/lib/notifications');
    await notify({
      event: 'release_aborted',
      project: projectName,
      job_id: releaseJob.id,
      status: 'failed',
      log_url: `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(projectName)}/history`,
      timestamp: Date.now(),
    });
  } catch {}

  return NextResponse.json({
    status: 'aborted',
    release_id: releaseJob.id,
    killed_job_id: runningStep?.id ?? null,
  });
}
