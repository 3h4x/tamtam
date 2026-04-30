import { describe, it, expect } from 'vitest'
import { isPipelineBusy, PIPELINE_KINDS } from '../../lib/pipeline/pipeline-status'
import type { JobInfo } from '../../lib/client-api'

function job(partial: Partial<JobInfo> & { kind: string; status: 'running' | 'done' }): JobInfo {
  return {
    id: 'j',
    project: 'p',
    prompt: null,
    pid: 0,
    log_path: '',
    exit_code: partial.status === 'done' ? 0 : null,
    started_at: 1,
    finished_at: partial.status === 'done' ? 2 : null,
    seen: true,
    ...partial,
  } as JobInfo
}

describe('isPipelineBusy', () => {
  it('returns false for an empty job list', () => {
    expect(isPipelineBusy([])).toBe(false)
  })

  it.each(PIPELINE_KINDS)('returns true when a %s job is running', (kind) => {
    expect(isPipelineBusy([job({ kind, status: 'running' })])).toBe(true)
  })

  it.each(PIPELINE_KINDS)('returns false when the only %s job is done', (kind) => {
    expect(isPipelineBusy([job({ kind, status: 'done' })])).toBe(false)
  })

  it('flags commit/push phase as busy — the bug we fixed', () => {
    // Release is running, it just kicked off a push, commit is in flight.
    // Previously the Release button stayed enabled because only review/test/fix
    // were checked. Regression guard: push must flip the flag.
    const jobs = [
      job({ kind: 'release', status: 'running' }),
      job({ kind: 'push', status: 'running' }),
    ]
    expect(isPipelineBusy(jobs)).toBe(true)
  })

  it('ignores unrelated kinds', () => {
    const jobs = [
      job({ kind: 'run', status: 'running' }),
      job({ kind: 'agent:improve', status: 'running' }),
      job({ kind: 'fix-ci', status: 'running' }),
    ]
    expect(isPipelineBusy(jobs)).toBe(false)
  })

  it('includes fix-push (claude-driven push retry)', () => {
    expect(isPipelineBusy([job({ kind: 'fix-push', status: 'running' })])).toBe(true)
  })

  it('returns true if any one of many jobs is a running pipeline kind', () => {
    const jobs = [
      job({ kind: 'run', status: 'done' }),
      job({ kind: 'review', status: 'done' }),
      job({ kind: 'push', status: 'running' }),
      job({ kind: 'agent:foo', status: 'running' }),
    ]
    expect(isPipelineBusy(jobs)).toBe(true)
  })
})
