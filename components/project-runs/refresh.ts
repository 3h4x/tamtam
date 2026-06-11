import type { JobInfo } from '@/lib/client-api'

export function mergeJobs(newer: JobInfo[], older: JobInfo[], maxRows: number): JobInfo[] {
  const byId = new Map<string, JobInfo>()
  for (const job of older) byId.set(job.id, job)
  for (const job of newer) byId.set(job.id, job)
  return Array.from(byId.values())
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, maxRows)
}

export function reconcileRefreshJobs(
  newer: JobInfo[],
  older: JobInfo[],
  maxRows: number,
  total: number | undefined,
  fetchedLimit: number,
): JobInfo[] {
  if (typeof total === 'number' && total <= fetchedLimit) {
    return [...newer].sort((a, b) => b.started_at - a.started_at).slice(0, maxRows)
  }
  return mergeJobs(newer, older, maxRows)
}
