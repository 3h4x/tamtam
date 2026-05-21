import type { JobInfo } from './types'

const JOBS_BASE = '/api/jobs'

export interface FetchJobsOptions {
  limit?: number
  offset?: number
  kind?: string
  status?: 'running' | 'done' | 'aborted'
  sessionId?: string
  hasSession?: boolean
}

export async function fetchJobs(
  project?: string,
  opts: FetchJobsOptions = {},
): Promise<{ jobs: JobInfo[]; total?: number; pendingReleaseProjects?: string[] }> {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit))
  if (typeof opts.offset === 'number') params.set('offset', String(opts.offset))
  if (opts.kind) params.set('kind', opts.kind)
  if (opts.status) params.set('status', opts.status)
  if (opts.sessionId) params.set('session_id', opts.sessionId)
  if (opts.hasSession) params.set('has_session', '1')
  const qs = params.toString()
  const url = qs ? `${JOBS_BASE}?${qs}` : JOBS_BASE
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch jobs: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchNotifications(): Promise<{ count: number; jobs: JobInfo[]; runningCount: number; runningJobs: JobInfo[] }> {
  const response = await fetch(`${JOBS_BASE}/notifications`)
  if (!response.ok) {
    throw new Error(`Failed to fetch notifications: ${response.statusText}`)
  }
  return response.json()
}

export async function markJobSeen(jobId: string): Promise<{ status: string }> {
  const response = await fetch(`${JOBS_BASE}/${encodeURIComponent(jobId)}/seen`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Failed to mark seen: ${response.statusText}`)
  }
  return response.json()
}

export async function markNotificationsSeen(): Promise<{ status: string }> {
  const response = await fetch(`${JOBS_BASE}/notifications/mark-seen`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Failed to mark seen: ${response.statusText}`)
  }
  return response.json()
}

export async function continueJob(
  jobId: string,
): Promise<{ status: string; job_id: string; resumed_session_id: string; resumed_from: string }> {
  const response = await fetch(`${JOBS_BASE}/${encodeURIComponent(jobId)}/continue`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to continue: ${response.statusText}`)
  }
  return response.json()
}

export async function syncJobBoard(jobId: string): Promise<{ status: string }> {
  const response = await fetch(`${JOBS_BASE}/${encodeURIComponent(jobId)}/board-sync`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to sync board item: ${response.statusText}`)
  }
  return response.json()
}
