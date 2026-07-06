import type { JobInfo } from './types'
import { cachedGet, invalidateGet, CachedGetError } from './request-cache'

const JOBS_BASE = '/api/jobs'
const NOTIFICATIONS_URL = `${JOBS_BASE}/notifications`

export interface FetchJobsOptions {
  limit?: number
  offset?: number
  kind?: string
  kindPrefix?: string
  status?: 'running' | 'done' | 'aborted'
  sessionId?: string
  hasSession?: boolean
  from?: number
  to?: number
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
  if (opts.kindPrefix) params.set('kind_prefix', opts.kindPrefix)
  if (opts.status) params.set('status', opts.status)
  if (opts.sessionId) params.set('session_id', opts.sessionId)
  if (opts.hasSession) params.set('has_session', '1')
  if (typeof opts.from === 'number') params.set('from', String(opts.from))
  if (typeof opts.to === 'number') params.set('to', String(opts.to))
  const qs = params.toString()
  const url = qs ? `${JOBS_BASE}?${qs}` : JOBS_BASE
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch jobs: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchNotifications(
  opts: { force?: boolean } = {},
): Promise<{ count: number; jobs: JobInfo[]; runningCount: number; runningJobs: JobInfo[] }> {
  // Deduped + short-TTL memo. The notification bell lives in the global shell,
  // so this fires on every page and re-fires across the mount/hydration churn —
  // the ~17KB payload was the largest duplicated GET on a page load. Routing it
  // through the shared cache collapses those near-concurrent duplicates into one
  // request. The 5s poll cadence is longer than the 2s memo, so each poll still
  // gets fresh data; only the mount-burst duplicates are shared. `markJobSeen` /
  // `markNotificationsSeen` invalidate the memo so a seen action is reflected on
  // the very next poll instead of after the memo expires.
  try {
    return await cachedGet(NOTIFICATIONS_URL, { ttlMs: 2000, force: opts.force })
  } catch (e) {
    if (e instanceof CachedGetError) throw new Error(`Failed to fetch notifications: ${e.statusText}`, { cause: e })
    throw e
  }
}

export async function markJobSeen(jobId: string): Promise<{ status: string }> {
  const response = await fetch(`${JOBS_BASE}/${encodeURIComponent(jobId)}/seen`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Failed to mark seen: ${response.statusText}`)
  }
  // Drop the notifications memo so the next poll reflects the seen state.
  invalidateGet(NOTIFICATIONS_URL)
  return response.json()
}

export async function markNotificationsSeen(): Promise<{ status: string }> {
  const response = await fetch(`${JOBS_BASE}/notifications/mark-seen`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Failed to mark seen: ${response.statusText}`)
  }
  // Drop the notifications memo so the next poll reflects the cleared state.
  invalidateGet(NOTIFICATIONS_URL)
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
