import { getLock, releaseLock } from '@/lib/pipeline/pipeline-lock';
import { getJob, listJobs, updateJob } from '@/lib/jobs/job-storage';
import { finalizeAbortedRelease } from '@/lib/jobs/lifecycle';
import {
  requestJobCancellation,
  SAFE_PID_FLOOR,
  shouldSignalJobPid,
  shouldSignalJobPidForWallClockTimeout,
} from '@/lib/jobs/cancellation';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import type { JobData } from '@/lib/jobs/types';

export type ReleaseAbortResult =
  | { status: 'no_pipeline'; detail: string; httpStatus: 200 }
  | { status: 'abort_pending'; detail: string; release_id: string; killed_job_id: null; httpStatus: 409 }
  | { status: 'aborted'; release_id: string; killed_job_id: string | null; httpStatus: 200 };

export interface AbortActiveReleaseOptions {
  reason: 'user' | 'wall_clock_timeout';
  targetReleaseId?: string;
}

function findLatestActiveRelease(projectName: string): JobData | null {
  let latest: JobData | null = null;
  for (const job of listJobs()) {
    if (job.project !== projectName || job.kind !== 'release' || job.finishedAt !== null) continue;
    if (!latest || (job.startedAt ?? 0) > (latest.startedAt ?? 0)) latest = job;
  }
  return latest;
}

async function resolveTargetRelease(
  projectName: string,
  targetReleaseId?: string,
): Promise<{ releaseJob: ReturnType<typeof getJob>; lockJobId: string | null }> {
  const lock = await getLock(projectName);
  const lockJobId = lock?.lockedByJobId ?? null;

  if (targetReleaseId) {
    const targeted = getJob(targetReleaseId);
    if (targeted?.project === projectName && targeted.kind === 'release' && targeted.finishedAt === null) {
      return { releaseJob: targeted, lockJobId };
    }
    return { releaseJob: null, lockJobId };
  }

  let releaseJob = lockJobId ? getJob(lockJobId) : null;
  if (releaseJob && releaseJob.kind === 'release' && releaseJob.finishedAt === null) {
    return { releaseJob, lockJobId };
  }

  releaseJob = findLatestActiveRelease(projectName);
  return { releaseJob, lockJobId };
}

export async function abortActiveRelease(
  projectName: string,
  options: AbortActiveReleaseOptions,
): Promise<ReleaseAbortResult> {
  const { releaseJob, lockJobId } = await resolveTargetRelease(projectName, options.targetReleaseId);
  if (!releaseJob) {
    if (lockJobId && !options.targetReleaseId) {
      await releaseLock(projectName, lockJobId);
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

  if (runningStep) {
    // Job termination is handled by requestJobCancellation for push/commit
    // kinds and by process.kill on the child PID for everything else.

    if (runningStep.kind === 'push' || runningStep.kind === 'commit') {
      runningStep.cancelRequestedExitCode = -3;
      const cancelled = await requestJobCancellation(runningStep.id, 20_000);
      if (!cancelled && runningStep.finishedAt === null) {
        if (options.reason !== 'wall_clock_timeout') {
          // User-triggered abort: report `abort_pending` so the operator sees
          // the step is still draining and can retry.
          return {
            status: 'abort_pending',
            detail: `Timed out waiting for ${runningStep.kind} to stop cleanly`,
            release_id: releaseJob.id,
            killed_job_id: null,
            httpStatus: 409,
          };
        }
        if (!shouldSignalJobPidForWallClockTimeout(runningStep)) {
          console.warn(
            `[release-abort] wall-clock timeout: refusing to finalize ${runningStep.kind} ${runningStep.id} without a safe signal target (pid=${runningStep.pid})`,
          );
          return {
            status: 'abort_pending',
            detail: `Timed out waiting for ${runningStep.kind} to stop cleanly`,
            release_id: releaseJob.id,
            killed_job_id: null,
            httpStatus: 409,
          };
        }
        console.warn(
          `[release-abort] wall-clock timeout: push/commit ${runningStep.id} did not cancel within 20s; SIGTERM+SIGKILL pid=${runningStep.pid}`,
        );
        try { process.kill(runningStep.pid, 'SIGTERM'); } catch {}
        setTimeout(() => {
          try { process.kill(runningStep.pid, 'SIGKILL'); } catch {}
        }, 2000);
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
