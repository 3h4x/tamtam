import type { JobInfo } from './types'

const JOBS_BASE = '/api/jobs'

export async function fetchJobs(
  project?: string,
  opts: { limit?: number } = {},
): Promise<{ jobs: JobInfo[]; total?: number; pendingReleaseProjects?: string[] }> {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit))
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
  const response = await fetch(`${JOBS_BASE}/${jobId}/seen`, {
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

export async function syncJobBoard(jobId: string): Promise<{ status: string }> {
  const response = await fetch(`${JOBS_BASE}/${jobId}/board-sync`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to sync board item: ${response.statusText}`)
  }
  return response.json()
}
