import { describe, expect, it } from 'vitest'
import { jobIsFinished } from '@/lib/client/job-status'

describe('jobIsFinished', () => {
  // The other helpers (jobIsRunning / jobIsAborted / jobNeedsAttention /
  // jobSucceeded) were removed when grep confirmed they had no callers.
  // Only the finished-check survives because NotificationBell uses it to
  // gate `markJobSeen`. If a future caller needs the dropped helpers,
  // re-add them with corresponding tests — but don't keep speculative
  // surface around just to feel "complete".

  it('returns true for terminal statuses', () => {
    expect(jobIsFinished({ status: 'done' })).toBe(true)
    expect(jobIsFinished({ status: 'aborted' })).toBe(true)
    expect(jobIsFinished({ status: 'completed' })).toBe(true)
    expect(jobIsFinished({ status: 'failed' })).toBe(true)
  })

  it('returns false for running jobs', () => {
    expect(jobIsFinished({ status: 'running' })).toBe(false)
  })
})
