import { describe, it, expect } from 'vitest'
import { buildEntries } from '../../components/project-runs/utils'
import type { JobInfo } from '../../lib/client-api'

function job(partial: Partial<JobInfo> & { id: string; kind: string; started_at: number }): JobInfo {
  return {
    project: 'p',
    prompt: null,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    finished_at: partial.started_at + 1,
    seen: true,
    ...partial,
  } as JobInfo
}

describe('buildEntries session grouping', () => {
  it('collapses jobs sharing a session_id into one entry', () => {
    const jobs = [
      job({ id: 'a', kind: 'run', started_at: 100, session_id: 'S1', user_prompt: 'hi' }),
      job({ id: 'b', kind: 'run', started_at: 200, session_id: 'S1', user_prompt: 'more' }),
      job({ id: 'c', kind: 'run', started_at: 300, session_id: 'S1', user_prompt: 'again' }),
    ]
    const entries = buildEntries(jobs)
    expect(entries).toHaveLength(1)
    expect(entries[0].turns).toBe(3)
    expect(entries[0].key).toBe('sess:S1')
    expect(entries[0].navJobId).toBe('c')
    expect(entries[0].navSessionId).toBe('S1')
  })

  it('merges agent and chat jobs when they share a session_id', () => {
    const jobs = [
      job({ id: 'agent1', kind: 'agent:improve', started_at: 100, session_id: 'S1', user_prompt: 'run agent' }),
      job({ id: 'chat1', kind: 'run', started_at: 200, session_id: 'S1', user_prompt: 'follow-up' }),
    ]
    const entries = buildEntries(jobs)
    expect(entries).toHaveLength(1)
    expect(entries[0].turns).toBe(2)
    // The first job in the session determines the kind/bucket — agent wins.
    expect(entries[0].bucket).toBe('agent')
    expect(entries[0].navJobId).toBe('chat1')
  })

  it('keeps jobs without a session_id as separate entries', () => {
    const jobs = [
      job({ id: 'a', kind: 'run', started_at: 100, user_prompt: 'one' }),
      job({ id: 'b', kind: 'run', started_at: 200, user_prompt: 'two' }),
    ]
    const entries = buildEntries(jobs)
    expect(entries).toHaveLength(2)
  })

  it('does not merge different sessions even if same kind', () => {
    const jobs = [
      job({ id: 'a', kind: 'run', started_at: 100, session_id: 'S1', user_prompt: 'x' }),
      job({ id: 'b', kind: 'run', started_at: 200, session_id: 'S2', user_prompt: 'y' }),
    ]
    const entries = buildEntries(jobs)
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.key).sort()).toEqual(['sess:S1', 'sess:S2'])
  })

  it('sums token totals and tracks last activity time across a session', () => {
    const jobs = [
      job({ id: 'a', kind: 'run', started_at: 100, session_id: 'S1', input_tokens: 10, output_tokens: 20, cache_read_tokens: 5, duration_ms: 1000 }),
      job({ id: 'b', kind: 'run', started_at: 250, session_id: 'S1', input_tokens: 30, output_tokens: 40, cache_read_tokens: 15, duration_ms: 2000 }),
    ]
    const [entry] = buildEntries(jobs)
    expect(entry.inputTokens).toBe(40)
    expect(entry.outputTokens).toBe(60)
    expect(entry.cacheReadTokens).toBe(20)
    expect(entry.durationMs).toBe(3000)
    expect(entry.lastActivityAt).toBe(250)
    expect(entry.startedAt).toBe(100)
  })

  it('reflects the latest job status on the merged entry', () => {
    const jobs = [
      job({ id: 'a', kind: 'run', started_at: 100, session_id: 'S1', status: 'done', finished_at: 150, exit_code: 0 }),
      job({ id: 'b', kind: 'run', started_at: 200, session_id: 'S1', status: 'running', finished_at: null, exit_code: null }),
    ]
    const [entry] = buildEntries(jobs)
    expect(entry.status).toBe('running')
    expect(entry.finishedAt).toBe(null)
    expect(entry.exitCode).toBe(null)
  })

  it('orders entries by most recent activity first', () => {
    const jobs = [
      job({ id: 'old', kind: 'run', started_at: 100, session_id: 'A' }),
      job({ id: 'new', kind: 'run', started_at: 500, session_id: 'B' }),
      job({ id: 'mid', kind: 'run', started_at: 300, session_id: 'A' }),
    ]
    const entries = buildEntries(jobs)
    expect(entries.map(e => e.key)).toEqual(['sess:B', 'sess:A'])
  })
})
