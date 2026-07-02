import { describe, it, expect } from 'vitest'
import {
  groupWorkUnits,
  mergeWorkUnits,
  isInternalUnit,
  INTERNAL_KINDS,
} from '@/components/project-runs/work-units'
import type { Entry } from '@/components/project-runs/types'
import type { KindBucket } from '@/components/project-runs/kinds'

function makeEntry(p: Partial<Entry> & { key: string; kind: string; bucket: KindBucket }): Entry {
  return {
    key: p.key,
    project: p.project ?? 'proj',
    kind: p.kind,
    bucket: p.bucket,
    title: p.title ?? p.kind,
    subtitle: null,
    startedAt: p.startedAt ?? 1000,
    lastActivityAt: p.lastActivityAt ?? p.startedAt ?? 1000,
    finishedAt: p.finishedAt ?? p.startedAt ?? 1000,
    status: p.status ?? 'done',
    exitCode: p.exitCode ?? 0,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    turns: 1,
    model: null,
    navJobId: p.navJobId ?? p.key,
    navSessionId: null,
    releaseId: p.releaseId ?? null,
    verdict: p.verdict,
    failureLabel: null,
    releaseOutcome: null,
    logPruned: false,
    workSummary: null,
    modifiedFiles: null,
    parentJobId: p.parentJobId ?? null,
    parentLabel: null,
    _jobIds: [p.navJobId ?? p.key],
  }
}

describe('groupWorkUnits', () => {
  it('classifies mark-dod-verify as internal, keeps agent/release/run as roots', () => {
    const entries = [
      makeEntry({ key: 'a1', kind: 'agent:cruncher', bucket: 'agent', startedAt: 400 }),
      makeEntry({ key: 'r1', kind: 'release', bucket: 'release', startedAt: 300 }),
      makeEntry({ key: 'c1', kind: 'run', bucket: 'run', startedAt: 200 }),
      makeEntry({ key: 'v1', kind: 'mark-dod-verify', bucket: 'other', startedAt: 100 }),
      makeEntry({ key: 'v2', kind: 'mark-dod-verify', bucket: 'other', startedAt: 90 }),
    ]
    const { roots, internal } = groupWorkUnits(entries)
    expect(roots.map((e) => e.kind).sort()).toEqual(['agent:cruncher', 'release', 'run'])
    expect(internal.map((e) => e.kind)).toEqual(['mark-dod-verify', 'mark-dod-verify'])
  })

  it('keeps non-verify custom actions (bucket "other") visible as roots', () => {
    const entries = [
      makeEntry({ key: 'act1', kind: 'deploy', bucket: 'other', startedAt: 200 }),
      makeEntry({ key: 'v1', kind: 'mark-dod-verify', bucket: 'other', startedAt: 100 }),
    ]
    const { roots, internal } = groupWorkUnits(entries)
    expect(roots.map((e) => e.kind)).toEqual(['deploy'])
    expect(internal.map((e) => e.kind)).toEqual(['mark-dod-verify'])
  })

  it('nests pipeline steps under their release (release stays the only root)', () => {
    const entries = [
      makeEntry({ key: 'r1', kind: 'release', bucket: 'release', navJobId: 'rel', startedAt: 100, finishedAt: 200 }),
      makeEntry({ key: 't1', kind: 'test', bucket: 'test', releaseId: 'rel', startedAt: 110, finishedAt: 120 }),
      makeEntry({ key: 'rv1', kind: 'review', bucket: 'review', releaseId: 'rel', startedAt: 130, finishedAt: 150, verdict: 'LGTM' }),
    ]
    const { roots, internal } = groupWorkUnits(entries)
    expect(roots).toHaveLength(1)
    expect(roots[0].kind).toBe('release')
    expect((roots[0].children ?? []).map((c) => c.kind)).toEqual(['test', 'review'])
    expect(internal).toHaveLength(0)
  })
})

describe('mergeWorkUnits', () => {
  it('merges roots + internal, newest activity first', () => {
    const grouped = {
      roots: [makeEntry({ key: 'a', kind: 'agent:x', bucket: 'agent', lastActivityAt: 300 })],
      internal: [
        makeEntry({ key: 'v1', kind: 'mark-dod-verify', bucket: 'other', lastActivityAt: 500 }),
        makeEntry({ key: 'v2', kind: 'mark-dod-verify', bucket: 'other', lastActivityAt: 100 }),
      ],
    }
    expect(mergeWorkUnits(grouped).map((e) => e.key)).toEqual(['v1', 'a', 'v2'])
  })
})

describe('isInternalUnit', () => {
  it('flags mark-dod-verify only', () => {
    expect(INTERNAL_KINDS.has('mark-dod-verify')).toBe(true)
    expect(isInternalUnit(makeEntry({ key: 'x', kind: 'mark-dod-verify', bucket: 'other' }))).toBe(true)
    expect(isInternalUnit(makeEntry({ key: 'x', kind: 'fix-ci', bucket: 'fix-ci' }))).toBe(false)
    expect(isInternalUnit(makeEntry({ key: 'x', kind: 'agent:x', bucket: 'agent' }))).toBe(false)
  })
})
