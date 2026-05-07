import { describe, expect, it } from 'vitest'
import {
  jobIsAborted,
  jobIsFinished,
  jobIsRunning,
  jobNeedsAttention,
  jobSucceeded,
} from '@/lib/client/job-status'

describe('job-status', () => {
  it('identifies running, aborted, and finished jobs', () => {
    expect(jobIsRunning({ status: 'running' })).toBe(true)
    expect(jobIsRunning({ status: 'completed' })).toBe(false)

    expect(jobIsAborted({ status: 'aborted' })).toBe(true)
    expect(jobIsAborted({ status: 'failed' })).toBe(false)

    expect(jobIsFinished({ status: 'running' })).toBe(false)
    expect(jobIsFinished({ status: 'completed' })).toBe(true)
    expect(jobIsFinished({ status: 'aborted' })).toBe(true)
  })

  it('flags aborted and non-zero exit codes as needing attention', () => {
    expect(jobNeedsAttention({ status: 'aborted', exit_code: null })).toBe(true)
    expect(jobNeedsAttention({ status: 'failed', exit_code: 1 })).toBe(true)
    expect(jobNeedsAttention({ status: 'completed', exit_code: 0 })).toBe(false)
    expect(jobNeedsAttention({ status: 'completed', exit_code: null })).toBe(false)
    expect(jobNeedsAttention({ status: 'running', exit_code: 1 })).toBe(false)
  })

  it('treats zero and null exit codes as success only after the job finishes', () => {
    expect(jobSucceeded({ status: 'completed', exit_code: 0 })).toBe(true)
    expect(jobSucceeded({ status: 'completed', exit_code: null })).toBe(true)
    expect(jobSucceeded({ status: 'failed', exit_code: 1 })).toBe(false)
    expect(jobSucceeded({ status: 'aborted', exit_code: 0 })).toBe(false)
    expect(jobSucceeded({ status: 'running', exit_code: 0 })).toBe(false)
  })
})
