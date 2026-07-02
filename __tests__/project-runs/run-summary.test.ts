import { describe, it, expect } from 'vitest'
import {
  formatRunSummaryText,
  splitSummary,
  lastFailedSummaryPart,
  latestFailureSummary,
} from '@/components/project-runs/run-summary'
import type { Entry } from '@/components/project-runs/types'
import type { KindBucket } from '@/components/project-runs/kinds'

function makeEntry(p: Partial<Entry> & { key: string; kind: string; bucket: KindBucket }): Entry {
  return {
    key: p.key,
    project: 'proj',
    kind: p.kind,
    bucket: p.bucket,
    title: p.title ?? p.kind,
    subtitle: p.subtitle ?? null,
    detail: p.detail ?? null,
    startedAt: p.startedAt ?? 1000,
    lastActivityAt: p.lastActivityAt ?? p.startedAt ?? 1000,
    finishedAt: p.finishedAt ?? 1000,
    status: p.status ?? 'done',
    exitCode: p.exitCode ?? 0,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    turns: 1,
    model: null,
    navJobId: p.key,
    navSessionId: null,
    releaseId: null,
    verdict: p.verdict,
    failureLabel: null,
    releaseOutcome: null,
    logPruned: false,
    workSummary: p.workSummary ?? null,
    modifiedFiles: null,
    parentJobId: null,
    parentLabel: null,
    children: p.children,
    chainedChildren: p.chainedChildren,
    _jobIds: [p.key],
  }
}

describe('formatRunSummaryText', () => {
  it('returns null for empty input', () => {
    expect(formatRunSummaryText(null)).toBeNull()
    expect(formatRunSummaryText('')).toBeNull()
    expect(formatRunSummaryText('   ')).toBeNull()
  })

  it('passes unstructured prose through, trimmed', () => {
    expect(formatRunSummaryText('  did a thing  ')).toBe('did a thing')
  })

  it('breaks a structured report into labeled sections', () => {
    const raw = '**Summary:** fixed the bug Files changed: a.ts, b.ts'
    const out = formatRunSummaryText(raw)
    expect(out).toContain('Summary:')
    expect(out).toContain('Files changed:')
    // Inline sections are split onto their own lines.
    expect(out!.split('\n').length).toBeGreaterThan(1)
  })
})

describe('splitSummary', () => {
  it('splits a middot-joined recap into trimmed parts', () => {
    expect(splitSummary('test ✓ · review LGTM · commit ✓')).toEqual(['test ✓', 'review LGTM', 'commit ✓'])
  })
  it('returns [] for empty input', () => {
    expect(splitSummary(null)).toEqual([])
    expect(splitSummary('')).toEqual([])
  })
})

describe('lastFailedSummaryPart', () => {
  it('finds the last failing part', () => {
    expect(lastFailedSummaryPart(['test ✓', 'push ✗1'])).toBe('push ✗1')
    expect(lastFailedSummaryPart(['test ✓', 'review needs attention'])).toBe('review needs attention')
  })
  it('returns null when nothing failed', () => {
    expect(lastFailedSummaryPart(['test ✓', 'review LGTM'])).toBeNull()
  })
})

describe('latestFailureSummary', () => {
  it('surfaces the most recent failing child summary', () => {
    const parent = makeEntry({
      key: 'rel',
      kind: 'release',
      bucket: 'release',
      children: [
        makeEntry({ key: 't', kind: 'test', bucket: 'test', exitCode: 0, lastActivityAt: 10 }),
        makeEntry({
          key: 'p',
          kind: 'push',
          bucket: 'push',
          status: 'done',
          exitCode: 1,
          lastActivityAt: 20,
          workSummary: 'push rejected by pre-push hook',
        }),
      ],
    })
    expect(latestFailureSummary(parent)).toBe('push rejected by pre-push hook')
  })

  it('returns null when no child needs attention', () => {
    const parent = makeEntry({
      key: 'rel',
      kind: 'release',
      bucket: 'release',
      children: [makeEntry({ key: 't', kind: 'test', bucket: 'test', exitCode: 0 })],
    })
    expect(latestFailureSummary(parent)).toBeNull()
  })
})
