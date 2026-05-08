import { describe, it, expect } from 'vitest'
import { buildEntries, entryNeedsAttention, groupReleaseChildren } from '../../components/project-runs/utils'
import type { JobInfo } from '../../lib/client-api'

function job({
  id,
  kind,
  started_at,
  ...partial
}: Partial<JobInfo> & { id: string; kind: string; started_at: number }): JobInfo {
  return {
    id,
    kind,
    started_at,
    project: 'p',
    prompt: null,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    finished_at: started_at + 1,
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
    expect(entries[0].key).toBe('sess:p:S1')
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
    expect(entries.map(e => e.key).sort()).toEqual(['sess:p:S1', 'sess:p:S2'])
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

  it('carries latest agent summary metadata through session grouping', () => {
    const jobs = [
      job({ id: 'agent1', kind: 'agent:tests', started_at: 100, session_id: 'S1', work_summary: 'Checked coverage.', modified_files: '[]' }),
      job({ id: 'chat1', kind: 'run', started_at: 200, session_id: 'S1', user_prompt: 'follow-up', work_summary: 'Followed up.', modified_files: '[{"path":"src/a.ts","status":"M"}]' }),
    ]
    const [entry] = buildEntries(jobs)
    expect(entry.workSummary).toBe('Followed up.')
    expect(entry.modifiedFiles).toContain('src/a.ts')
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
    expect(entries.map(e => e.key)).toEqual(['sess:p:B', 'sess:p:A'])
  })

  it('keeps review and fix as separate entries even when they share a session_id (--resume)', () => {
    // Regression: a fix job that resumes the review's Claude session via
    // `--resume <sessionId>` shares the session for context but is a
    // distinct pipeline step. They must not collapse into one entry
    // labeled "review 2 turns" — that hid the fix from the user.
    const jobs = [
      job({ id: 'review-1', kind: 'review', started_at: 100, session_id: 'S1', exit_code: 0, verdict: 'NEEDS ATTENTION' as JobInfo['verdict'] }),
      job({ id: 'fix-1', kind: 'fix', started_at: 200, session_id: 'S1', parent_job_id: 'review-1' }),
    ]
    const entries = buildEntries(jobs)
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.bucket).sort()).toEqual(['fix', 'review'])
    expect(entries.every(e => e.turns === 1)).toBe(true)
  })

  it('still merges multiple review turns under the same session into one entry', () => {
    const jobs = [
      job({ id: 'rev-1', kind: 'review', started_at: 100, session_id: 'S2' }),
      job({ id: 'rev-2', kind: 'review', started_at: 200, session_id: 'S2' }),
    ]
    const entries = buildEntries(jobs)
    expect(entries).toHaveLength(1)
    expect(entries[0].turns).toBe(2)
    expect(entries[0].bucket).toBe('review')
  })

  it('refreshes a merged review entry verdict from undefined to LGTM on the latest turn', () => {
    const jobs = [
      job({ id: 'rev-1', kind: 'review', started_at: 100, session_id: 'S2', verdict: undefined }),
      job({ id: 'rev-2', kind: 'review', started_at: 200, session_id: 'S2', verdict: 'LGTM' }),
    ]

    const [entry] = buildEntries(jobs)

    expect(entry.verdict).toBe('LGTM')
    expect(entryNeedsAttention(entry)).toBe(false)
  })

  it('refreshes a merged review entry verdict from NEEDS ATTENTION to LGTM on the latest turn', () => {
    const jobs = [
      job({ id: 'rev-1', kind: 'review', started_at: 100, session_id: 'S2', verdict: 'NEEDS ATTENTION' }),
      job({ id: 'rev-2', kind: 'review', started_at: 200, session_id: 'S2', verdict: 'LGTM' }),
    ]

    const [entry] = buildEntries(jobs)

    expect(entry.verdict).toBe('LGTM')
    expect(entryNeedsAttention(entry)).toBe(false)
  })

  it('refreshes a merged review entry verdict from LGTM to NEEDS ATTENTION on the latest turn', () => {
    const jobs = [
      job({ id: 'rev-1', kind: 'review', started_at: 100, session_id: 'S2', verdict: 'LGTM' }),
      job({ id: 'rev-2', kind: 'review', started_at: 200, session_id: 'S2', verdict: 'NEEDS ATTENTION' }),
    ]

    const [entry] = buildEntries(jobs)

    expect(entry.verdict).toBe('NEEDS ATTENTION')
    expect(entryNeedsAttention(entry)).toBe(true)
  })

  it('uses the latest merged review verdict when computing grouped pipeline state', () => {
    const entries = buildEntries([
      job({ id: 'test-1', kind: 'test', started_at: 100, finished_at: 110 }),
      job({ id: 'review-1', kind: 'review', started_at: 120, finished_at: 130, session_id: 'S3', verdict: 'NEEDS ATTENTION' }),
      job({ id: 'review-2', kind: 'review', started_at: 140, finished_at: 150, session_id: 'S3', verdict: 'LGTM' }),
    ])

    const grouped = groupReleaseChildren(entries)

    expect(grouped).toHaveLength(1)
    expect(grouped[0].kind).toBe('release')
    expect(grouped[0].failureLabel).toBeNull()
    expect(grouped[0].exitCode).toBe(0)
  })
})
