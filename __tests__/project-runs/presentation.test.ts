import { describe, it, expect } from 'vitest'
import {
  verdictBadgeInfo,
  gemmaOutcomeInfo,
  rowStateInfo,
  releaseOutcomeInfo,
  stepChipTone,
  progressToneClass,
  promptBloat,
  modifiedFileCount,
  parseModifiedFiles,
} from '@/components/project-runs/presentation'

describe('verdictBadgeInfo', () => {
  it('maps the three canonical verdicts', () => {
    expect(verdictBadgeInfo('LGTM')).toEqual({ label: '✓ LGTM', tone: 'success' })
    expect(verdictBadgeInfo('DO NOT SHIP')).toEqual({ label: '✗ DNS', tone: 'error' })
    expect(verdictBadgeInfo('NEEDS ATTENTION')).toEqual({ label: '⚠ ATTN', tone: 'warning' })
  })
  it('returns null when there is no verdict', () => {
    expect(verdictBadgeInfo(null)).toBeNull()
    expect(verdictBadgeInfo(undefined)).toBeNull()
  })
})

describe('gemmaOutcomeInfo', () => {
  it('maps outcome-classifier verdicts', () => {
    expect(gemmaOutcomeInfo('done')?.tone).toBe('success')
    expect(gemmaOutcomeInfo('asked_question')?.tone).toBe('info')
    expect(gemmaOutcomeInfo('needs_continue')?.tone).toBe('warning')
    expect(gemmaOutcomeInfo(null)).toBeNull()
  })
})

describe('rowStateInfo', () => {
  it('reports running', () => {
    expect(rowStateInfo({ isRunning: true, isFailed: false, exitCode: null })).toEqual({
      label: 'running',
      tone: 'info',
      running: true,
    })
  })
  it('reports done for success', () => {
    expect(rowStateInfo({ isRunning: false, isFailed: false, exitCode: 0 })).toMatchObject({
      label: 'done',
      tone: 'success',
    })
  })
  it('renders the -1 spawn sentinel as "failed to start"', () => {
    expect(rowStateInfo({ isRunning: false, isFailed: true, exitCode: -1 }).label).toBe('failed to start')
  })
  it('prefers an explicit failure label over a raw exit code', () => {
    expect(rowStateInfo({ isRunning: false, isFailed: true, exitCode: 1, failureLabel: 'release blocked' }).label)
      .toBe('release blocked')
  })
  it('falls back to exit N', () => {
    expect(rowStateInfo({ isRunning: false, isFailed: true, exitCode: 2 }).label).toBe('exit 2')
  })
})

describe('releaseOutcomeInfo', () => {
  it('maps outcome status to tone', () => {
    expect(releaseOutcomeInfo({ status: 'done', label: 'x', releaseJobId: 'r' })).toEqual({ label: '✓ release done', tone: 'success' })
    expect(releaseOutcomeInfo({ status: 'running', label: 'release running', releaseJobId: 'r' })?.tone).toBe('info')
    expect(releaseOutcomeInfo({ status: 'blocked', label: 'release blocked', releaseJobId: 'r' })?.tone).toBe('warning')
    expect(releaseOutcomeInfo({ status: 'failed', label: 'release failed', releaseJobId: 'r' })?.tone).toBe('error')
    expect(releaseOutcomeInfo(null)).toBeNull()
  })
})

describe('stepChipTone', () => {
  it('infers tone from the chip text', () => {
    expect(stepChipTone('commit ✓')).toBe('success')
    expect(stepChipTone('review LGTM')).toBe('success')
    expect(stepChipTone('push ✗1')).toBe('error')
    expect(stepChipTone('review needs attention')).toBe('error')
    expect(stepChipTone('fix pending')).toBe('info')
    expect(stepChipTone('soak')).toBe('neutral')
  })
})

describe('progressToneClass', () => {
  it('is info for live steps, error for stopped', () => {
    expect(progressToneClass('now: review')).toContain('status-info')
    expect(progressToneClass('failed at push')).toContain('status-error')
    expect(progressToneClass('completed through review')).toContain('accent')
    expect(progressToneClass(null)).toContain('accent')
  })
})

describe('promptBloat', () => {
  it('respects the 20KB warn / 50KB alert thresholds', () => {
    expect(promptBloat(19_000).show).toBe(false)
    expect(promptBloat(20_000)).toMatchObject({ show: true, alert: false })
    expect(promptBloat(50_000)).toMatchObject({ show: true, alert: true })
    expect(promptBloat(75_000).label).toBe('73KB')
    expect(promptBloat(500).label).toBe('500B')
    expect(promptBloat(null).show).toBe(false)
  })
})

describe('modifiedFiles helpers', () => {
  it('counts and parses a JSON array; tolerates garbage', () => {
    expect(modifiedFileCount('["a.ts","b.ts"]')).toBe(2)
    expect(modifiedFileCount('not json')).toBe(0)
    expect(modifiedFileCount(null)).toBe(0)
    expect(parseModifiedFiles('["a.ts","b.ts"]')).toEqual(['a.ts', 'b.ts'])
    expect(parseModifiedFiles('{}')).toEqual([])
  })
})
