import type { JobInfo } from '@/lib/client-api'

export function jobIsRunning(job: Pick<JobInfo, 'status'>): boolean {
  return job.status === 'running'
}

export function jobIsAborted(job: Pick<JobInfo, 'status'>): boolean {
  return job.status === 'aborted'
}

export function jobIsFinished(job: Pick<JobInfo, 'status'>): boolean {
  return job.status !== 'running'
}

export function jobNeedsAttention(job: Pick<JobInfo, 'status' | 'exit_code'>): boolean {
  if (job.status === 'aborted') return true
  return job.status !== 'running' && job.exit_code !== null && job.exit_code !== 0
}

export function jobSucceeded(job: Pick<JobInfo, 'status' | 'exit_code'>): boolean {
  if (job.status === 'running' || job.status === 'aborted') return false
  return job.exit_code === 0 || job.exit_code === null
}
