import { describe, expect, it } from 'vitest'
import {
  extractFindingIds,
  findingsIdentity,
  stripFinalVerdict,
} from '@/lib/pipeline/review-contract'

describe('review-contract helpers', () => {
  it('strips only a trailing final verdict marker', () => {
    const text = [
      'Findings:',
      '- Finding ID: duplicate-check-missing',
      '  Severity: high',
      '',
      'Verdict: NEEDS ATTENTION',
    ].join('\n')

    expect(stripFinalVerdict(text)).toBe([
      'Findings:',
      '- Finding ID: duplicate-check-missing',
      '  Severity: high',
    ].join('\n'))
  })

  it('keeps earlier verdict mentions and bare trailing lines intact', () => {
    const withInlineVerdict = [
      'The prior run said Verdict: LGTM but that was stale.',
      'Findings: none',
    ].join('\n')
    const withBareVerdict = [
      'Findings: none',
      'LGTM',
    ].join('\n')

    expect(stripFinalVerdict(withInlineVerdict)).toBe(withInlineVerdict)
    expect(stripFinalVerdict(withBareVerdict)).toBe(withBareVerdict)
  })

  it('extracts finding ids case-insensitively, de-duplicates them, and sorts them', () => {
    const text = [
      'Findings:',
      '- Finding ID: Missing-Docs',
      '- Finding ID: missing-docs',
      '* Finding ID: api/regression',
      '  Finding ID: z-last',
    ].join('\n')

    expect(extractFindingIds(text)).toEqual(['api/regression', 'missing-docs', 'z-last'])
  })

  it('builds a stable findings identity only when at least one id is present', () => {
    expect(findingsIdentity('Findings: none')).toBeNull()
    expect(findingsIdentity([
      '- Finding ID: b-item',
      '- Finding ID: a-item',
    ].join('\n'))).toBe('a-item|b-item')
  })
})
