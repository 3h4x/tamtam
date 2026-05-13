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

export type ReleaseAbortResult =
  | { status: 'no_pipeline'; detail: string; httpStatus: 200 }
  | { status: 'abort_pending'; detail: string; release_id: string; killed_job_id: null; httpStatus: 409 }
  | { status: 'aborted'; release_id: string; killed_job_id: string | null; httpStatus: 200 };

export interface AbortActiveReleaseOptions {
  reason: 'user' | 'wall_clock_timeout';
  targetReleaseId?: string;
}

function resolveTargetRelease(
  projectName: string,
  targetReleaseId?: string,
): { releaseJob: ReturnType<typeof getJob>; lockJobId: string | null } {
  const lock = getLock(projectName);
  const lockJobId = lock?.lockedByJobId ?? null;

  if (targetReleaseId) {
    const targeted = getJob(targetReleaseId)
      ?? listJobs().find((job) => job.id === targetReleaseId)
      ?? null;
    if (targeted?.project === projectName && targeted.kind === 'release' && targeted.finishedAt === null) {
      return { releaseJob: targeted, lockJobId };
    }
    return { releaseJob: null, lockJobId };
  }

  let releaseJob = lockJobId ? getJob(lockJobId) : null;
  if (releaseJob && releaseJob.kind === 'release' && releaseJob.finishedAt === null) {
    return { releaseJob, lockJobId };
  }

  releaseJob = listJobs()
    .filter((job) => job.project === projectName && job.kind === 'release' && job.finishedAt === null)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null;
  return { releaseJob, lockJobId };
}

export async function abortActiveRelease(
  projectName: string,
  options: AbortActiveReleaseOptions,
): Promise<ReleaseAbortResult> {
  const { releaseJob, lockJobId } = resolveTargetRelease(projectName, options.targetReleaseId);
  if (!releaseJob) {
    if (lockJobId && !options.targetReleaseId) {
      releaseLock(projectName, lockJobId);
    }
    return {
      status: 'no_pipeline',
      detail: options.targetReleaseId
        ? 'target release is not active'
        : lockJobId
          ? 'release already finished'
          : 'no active pipeline lock',
      httpStatus: 200,
    };
  }

  const now = Date.now() / 1000;
  const runningStep = listJobs().find(
    j => j.releaseId === releaseJob.id
      && j.finishedAt === null
      && j.kind !== 'release'
      && j.id !== releaseJob.parentJobId
  );

  releaseJob.abortedAt = now;
  updateJob(releaseJob);
  if (releaseJob.logPath) {
    try {
      const label = options.reason === 'wall_clock_timeout'
        ? 'wall-clock timeout'
        : 'user';
      appendRedactedFileSync(releaseJob.logPath, `\n# release aborted by ${label} — ${new Date().toISOString()}\n`);
    } catch {}
  }

  if (runningStep) {
    try {
      await exec('pm2', ['stop', runningStep.id, '--silent'], { timeout: 5000 });
      await exec('pm2', ['delete', runningStep.id, '--silent'], { timeout: 5000 });
    } catch {}

    if (runningStep.kind === 'push' || runningStep.kind === 'commit') {
      runningStep.cancelRequestedExitCode = -3;
      const cancelled = await requestJobCancellation(runningStep.id, 20_000);
      if (!cancelled && runningStep.finishedAt === null) {
        return {
          status: 'abort_pending',
          detail: `Timed out waiting for ${runningStep.kind} to stop cleanly`,
          release_id: releaseJob.id,
          killed_job_id: null,
          httpStatus: 409,
        };
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
        reason: options.reason,
        log_url: `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(projectName)}/history`,
        timestamp: Date.now(),
      });
    } catch {}
  }

  return {
    status: 'aborted',
    release_id: releaseJob.id,
    killed_job_id: runningStep?.id ?? null,
    httpStatus: 200,
  };
}
