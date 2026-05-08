import { describe, expect, it } from 'vitest'
import {
  extractFindingIds,
  extractFixClaims,
  findingsIdentity,
  parseFindings,
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

  it('extracts fix claims with status from the Fix checklist', () => {
    const text = [
      'Fix checklist:',
      '- Finding ID: leaky-cache',
      '  Status: fixed',
      '  Files changed: cache.ts',
      '- Finding ID: missing-handler',
      '  Status: not fixed',
      '  Remaining risk: requires schema migration',
    ].join('\n')

    expect(extractFixClaims(text)).toEqual([
      { id: 'leaky-cache', status: 'fixed' },
      { id: 'missing-handler', status: 'not fixed' },
    ])
  })

  it('omits fix claims that have no following Status line', () => {
    const text = [
      '- Finding ID: orphaned',
      '  Files changed: foo.ts',
      '- Finding ID: ok',
      '  Status: fixed',
    ].join('\n')

    expect(extractFixClaims(text)).toEqual([{ id: 'ok', status: 'fixed' }])
  })

  it('does not match incidental id: prose lines as fix claims', () => {
    const text = [
      'Findings:',
      '- Root cause: missing auth',
      '  id: shared-placeholder',
      '  Status: fixed',
    ].join('\n')

    expect(extractFixClaims(text)).toEqual([])
  })

  it('builds a stable findings identity only when at least one id is present', () => {
    expect(findingsIdentity('Findings: none')).toBeNull()
    expect(findingsIdentity([
      '- Finding ID: b-item',
      '- Finding ID: a-item',
    ].join('\n'))).toBe('a-item|b-item')
  })

  it('parses full contract findings without folding ignored contract fields into adjacent fields', () => {
    const text = [
      'Findings:',
      '- Finding ID: contract-fields-parsed-as-continuations',
      '  Severity: medium',
      '  Root cause: contract labels are treated as prose',
      '    across multiple continuation lines',
      '  Affected paths: lib/pipeline/review-contract.ts',
      '  Documentation: not required; implementation-only parser behavior',
      '  Required fix: parse every contract label deliberately',
      '    while preserving wrapped details',
      '  Required tests: parser coverage for full contract findings',
      '  Verification: pnpm test __tests__/lib/review-contract.test.ts',
      '',
      'Verdict: NEEDS ATTENTION',
    ].join('\n')

    expect(parseFindings(text)).toEqual([
      {
        id: 'contract-fields-parsed-as-continuations',
        severity: 'medium',
        rootCause: 'contract labels are treated as prose across multiple continuation lines',
        affectedPaths: 'lib/pipeline/review-contract.ts',
        requiredFix: 'parse every contract label deliberately while preserving wrapped details',
        requiredTests: 'parser coverage for full contract findings',
      },
    ])
  })
})
