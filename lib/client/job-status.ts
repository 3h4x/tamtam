import type { JobInfo } from '@/lib/client-api'

export type JobStatus = JobInfo['status'] | 'completed' | 'failed'

type JobStatusLike = { status: JobStatus }
type JobStatusWithExitCode = JobStatusLike & { exit_code: JobInfo['exit_code'] }

export function jobIsRunning(job: JobStatusLike): boolean {
  return job.status === 'running'
}

export function jobIsAborted(job: JobStatusLike): boolean {
  return job.status === 'aborted'
}

export function jobIsFinished(job: JobStatusLike): boolean {
  return job.status !== 'running'
}

export function jobNeedsAttention(job: JobStatusWithExitCode): boolean {
  if (job.status === 'aborted' || job.status === 'failed') return true
  return job.status !== 'running' && job.exit_code !== null && job.exit_code !== 0
}

export function jobSucceeded(job: JobStatusWithExitCode): boolean {
  if (job.status === 'running' || job.status === 'aborted' || job.status === 'failed') return false
  return job.exit_code === 0 || job.exit_code === null
}
