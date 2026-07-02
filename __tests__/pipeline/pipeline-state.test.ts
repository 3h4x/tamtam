import { describe, it, expect } from 'vitest'
import {
  stateOf,
  kindLabel,
  releaseIdFor,
  latestPipelineJobsByKind,
  derivePipelineState,
  PIPELINE_KIND_ORDER,
} from '@/lib/pipeline/pipeline-state'
import type { JobInfo } from '@/lib/client/types'

function job(p: Partial<JobInfo> & { id: string; kind: string }): JobInfo {
  return {
    project: 'proj',
    prompt: null,
    pid: 0,
    log_path: '',
    status: 'done',
    exit_code: 0,
    started_at: 1000,
    finished_at: 2000,
    seen: true,
    ...p,
  } as JobInfo
}

describe('kindLabel', () => {
  it('renames mark-dod → dod and pr-wait → merge', () => {
    expect(kindLabel('mark-dod')).toBe('dod')
    expect(kindLabel('pr-wait')).toBe('merge')
    expect(kindLabel('test')).toBe('test')
  })
})

describe('stateOf', () => {
  it('maps review verdicts', () => {
    expect(stateOf(job({ id: 'r', kind: 'review', verdict: 'LGTM' }))).toBe('done')
    expect(stateOf(job({ id: 'r', kind: 'review', verdict: 'NEEDS ATTENTION' }))).toBe('attention')
    expect(stateOf(job({ id: 'r', kind: 'review', verdict: 'DO NOT SHIP' }))).toBe('failed')
    expect(stateOf(job({ id: 'r', kind: 'review' }))).toBe('failed')
  })
  it('is running when the job is running', () => {
    expect(stateOf(job({ id: 't', kind: 'test', status: 'running', exit_code: null }))).toBe('running')
  })
  it('flags mark-dod attention when not all criteria verified', () => {
    expect(stateOf(job({ id: 'd', kind: 'mark-dod', exit_code: 0, context_meta: JSON.stringify({ verified: 3, total: 5 }) }))).toBe('attention')
    expect(stateOf(job({ id: 'd', kind: 'mark-dod', exit_code: 0, context_meta: JSON.stringify({ verified: 5, total: 5 }) }))).toBe('done')
  })
  it('uses exit code for ordinary steps', () => {
    expect(stateOf(job({ id: 'c', kind: 'commit', exit_code: 0 }))).toBe('done')
    expect(stateOf(job({ id: 'c', kind: 'commit', exit_code: 1 }))).toBe('failed')
  })
})

describe('releaseIdFor', () => {
  it('prefers the durable release_id', () => {
    const t = job({ id: 't', kind: 'test', release_id: 'rel-1' })
    expect(releaseIdFor(t, new Map([['t', t]]))).toBe('rel-1')
  })
  it('walks the parent chain up to the release meta-job', () => {
    const rel = job({ id: 'rel-1', kind: 'release' })
    const t = job({ id: 't', kind: 'test', parent_job_id: 'rel-1' })
    const rv = job({ id: 'rv', kind: 'review', parent_job_id: 't' })
    const byId = new Map([['rel-1', rel], ['t', t], ['rv', rv]])
    expect(releaseIdFor(rv, byId)).toBe('rel-1')
  })
})

describe('latestPipelineJobsByKind', () => {
  it('collapses each kind to its latest and orders by the pipeline', () => {
    const jobs = [
      job({ id: 'rv2', kind: 'review', started_at: 40 }),
      job({ id: 't', kind: 'test', started_at: 10 }),
      job({ id: 'rv1', kind: 'review', started_at: 20 }),
    ]
    const out = latestPipelineJobsByKind(jobs)
    expect(out.map((j) => j.kind)).toEqual(['test', 'review'])
    expect(out.find((j) => j.kind === 'review')!.id).toBe('rv2')
  })
})

describe('derivePipelineState', () => {
  it('returns an empty (pending) 8-phase track with no display job when nothing is active', () => {
    const s = derivePipelineState([])
    expect(s.displayJob).toBeNull()
    expect(s.track.map((p) => p.kind)).toEqual([...PIPELINE_KIND_ORDER])
    expect(s.track.every((p) => p.status === 'pending')).toBe(true)
  })

  it('derives the active release chain, summary, run counts and progress', () => {
    const rel = job({ id: 'rel-1', kind: 'release', status: 'running', exit_code: null })
    const t1 = job({ id: 't1', kind: 'test', release_id: 'rel-1', exit_code: 1, started_at: 10 })
    const fix = job({ id: 'fix1', kind: 'fix', release_id: 'rel-1', exit_code: 0, started_at: 20 })
    const t2 = job({ id: 't2', kind: 'test', release_id: 'rel-1', exit_code: 0, started_at: 30 })
    const rv = job({ id: 'rv', kind: 'review', release_id: 'rel-1', status: 'running', exit_code: null, started_at: 40 })
    const s = derivePipelineState([rel, t1, fix, t2, rv])
    expect(s.hasActiveRelease).toBe(true)
    expect(s.activeReleaseId).toBe('rel-1')
    expect(s.running).toBe(true)
    // test collapsed to latest (green), review running
    expect(s.steps.find((x) => x.kind === 'test')!.state).toBe('done')
    expect(s.steps.find((x) => x.kind === 'test')!.runs).toBe(2)
    expect(s.summary!.state).toBe('running')
    expect(s.summary!.label).toBe('review')
    // full 8-phase track, with commit/push/etc still pending
    expect(s.track.find((p) => p.kind === 'commit')!.status).toBe('pending')
    expect(s.track.find((p) => p.kind === 'review')!.status).toBe('running')
  })
})
