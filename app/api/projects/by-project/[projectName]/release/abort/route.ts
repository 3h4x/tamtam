import { NextRequest, NextResponse } from 'next/server';
import { getLock, releaseLock } from '@/lib/pipeline/pipeline-lock';
import { getJob, listJobs, updateJob } from '@/lib/jobs/job-storage';
import { finalizeAbortedRelease } from '@/lib/jobs/lifecycle';
import {
  requestJobCancellation,
  SAFE_PID_FLOOR,
  shouldSignalJobPid,
} from '@/lib/jobs/cancellation';
import { exec } from '@/lib/shared/shell';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const lock = await getLock(projectName);
  // Resolve the release we should abort. Normal case: lock-held release.
  // Orphan case: an unfinished `release` row with no lock (orchestrator died
  // between createReleaseJob and the first-step kickoff). Reap it too.
  let releaseJob = lock ? getJob(lock.lockedByJobId) : null;
  if (!releaseJob || releaseJob.kind !== 'release' || releaseJob.finishedAt !== null) {
    const orphan = listJobs().find(j =>
      j.project === projectName && j.kind === 'release' && j.finishedAt === null
    );
    if (orphan) {
      releaseJob = orphan;
    } else {
      if (lock) await releaseLock(projectName, lock.lockedByJobId);
      return NextResponse.json({ status: 'no_pipeline', detail: lock ? 'release already finished' : 'no active pipeline lock' }, { status: 200 });
    }
  }

  const now = Date.now() / 1000;

  // Find and kill the currently-running pipeline step job for this release.
  // Exclude the trigger job (the agent/run that spawned this release): it's
  // paired to the release for traceability, not orchestrated by it. It may
  // already be finished, but guard against killing a still-running parent.
  const runningStep = listJobs().find(
    j => j.releaseId === releaseJob.id
      && j.finishedAt === null
      && j.kind !== 'release'
      && j.id !== releaseJob.parentJobId
  );

  // Mark the release as aborting before we wait so late completion hooks do
  // not chain to the next step while the current inline child is unwinding.
  releaseJob.abortedAt = now;
  updateJob(releaseJob);
  if (releaseJob.logPath) {
    try {
      appendRedactedFileSync(releaseJob.logPath, `\n# release aborted by user — ${new Date().toISOString()}\n`);
    } catch {}
  }

  if (runningStep) {
    // Try pm2 stop first
    try {
      await exec('pm2', ['stop', runningStep.id, '--silent'], { timeout: 5000 });
      await exec('pm2', ['delete', runningStep.id, '--silent'], { timeout: 5000 });
    } catch {}

    if (runningStep.kind === 'push' || runningStep.kind === 'commit') {
      runningStep.cancelRequestedExitCode = -3;
      const cancelled = await requestJobCancellation(runningStep.id, 20_000);
      if (!cancelled && runningStep.finishedAt === null) {
        return NextResponse.json({
          status: 'abort_pending',
          detail: `Timed out waiting for ${runningStep.kind} to stop cleanly`,
          release_id: releaseJob.id,
          killed_job_id: null,
        }, { status: 409 });
      }
    } else if (shouldSignalJobPid(runningStep)) {
      try { process.kill(runningStep.pid, 'SIGTERM'); } catch {}
      setTimeout(() => {
        try { process.kill(runningStep.pid, 'SIGKILL'); } catch {}
      }, 2000);
    } else if (runningStep.pid > 0 && runningStep.pid <= SAFE_PID_FLOOR) {
      console.warn(
        `[release-abort] refusing to signal suspicious pid=${runningStep.pid} for ${runningStep.id} (${runningStep.kind})`,
      );
    }

    if (runningStep.finishedAt === null) {
      runningStep.abortedAt = now;
      runningStep.finishedAt = now;
      runningStep.exitCode = -3;
      updateJob(runningStep);
    }
  }

  const releaseAlreadyFinalized = releaseJob.finishedAt !== null;
  await finalizeAbortedRelease(releaseJob);

  if (!releaseAlreadyFinalized) {
    try {
      const { notify } = await import('@/lib/shared/notifications');
      await notify({
        event: 'release_aborted',
        project: projectName,
        job_id: releaseJob.id,
        status: 'failed',
        log_url: `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(projectName)}/history`,
        timestamp: Date.now(),
      });
    } catch {}
  }

  return NextResponse.json({
    status: 'aborted',
    release_id: releaseJob.id,
    killed_job_id: runningStep?.id ?? null,
  });
}
