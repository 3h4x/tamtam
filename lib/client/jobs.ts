import type { JobInfo } from './types'

const JOBS_BASE = '/api/jobs'

export async function fetchJobs(project?: string): Promise<{ jobs: JobInfo[] }> {
  const url = project ? `${JOBS_BASE}?project=${encodeURIComponent(project)}` : JOBS_BASE
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
