import { describe, expect, it } from 'vitest'
import { reconcileRefreshJobs } from '@/components/project-runs/refresh'
import type { JobInfo } from '@/lib/client-api'

function job(id: string, startedAt: number): JobInfo {
  return {
    id,
    project: 'alpha',
    kind: 'run',
    prompt: null,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    started_at: startedAt,
    finished_at: startedAt + 1,
    seen: true,
  }
}

describe('reconcileRefreshJobs', () => {
  it('keeps older visible rows when refresh is capped below the current window', () => {
    const older = Array.from({ length: 250 }, (_, i) => job(`old-${i}`, 1000 - i))
    const newer = older.slice(0, 200).map((entry) => ({ ...entry }))

    const result = reconcileRefreshJobs(newer, older, 250, 240, 200)

    expect(result).toHaveLength(250)
    expect(result.some((entry) => entry.id === 'old-249')).toBe(true)
  })

  it('replaces stale rows when the refresh response covers the full result set', () => {
    const older = [job('stale-running', 100), job('kept', 90)]
    const newer = [job('kept', 90)]

    const result = reconcileRefreshJobs(newer, older, 50, 1, 50)

    expect(result.map((entry) => entry.id)).toEqual(['kept'])
  })
})
