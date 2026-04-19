import { describe, it, expect } from 'vitest'
import { computePushBlockReason } from '@/lib/push-utils'

describe('computePushBlockReason', () => {
  it('returns no-changes message when totalChanges is 0', () => {
    expect(computePushBlockReason(0, false, 'LGTM')).toBe('No changes to push')
  })

  it('returns no-changes message even when hasUnreviewed is true and there are 0 changes', () => {
    expect(computePushBlockReason(0, true, null)).toBe('No changes to push')
  })

  it('returns review-first message when there are changes but unreviewed', () => {
    expect(computePushBlockReason(3, true, null)).toBe('Run a review first before pushing')
  })

  it('returns review-first message when unreviewed regardless of verdict', () => {
    expect(computePushBlockReason(5, true, 'LGTM')).toBe('Run a review first before pushing')
  })

  it('returns verdict message when verdict is not LGTM and reviewed', () => {
    expect(computePushBlockReason(2, false, 'NEEDS ATTENTION')).toBe(
      'Review verdict is "NEEDS ATTENTION" — fix issues before pushing',
    )
  })

  it('returns verdict message with DO NOT SHIP', () => {
    expect(computePushBlockReason(1, false, 'DO NOT SHIP')).toBe(
      'Review verdict is "DO NOT SHIP" — fix issues before pushing',
    )
  })

  it('returns no-review message when verdict is null', () => {
    expect(computePushBlockReason(1, false, null)).toBe(
      'No review on record — run a review before pushing',
    )
  })

  it('returns no-review message when verdict is undefined', () => {
    expect(computePushBlockReason(1, false, undefined)).toBe(
      'No review on record — run a review before pushing',
    )
  })

  it('returns null when changes exist, reviewed, and verdict is LGTM', () => {
    expect(computePushBlockReason(4, false, 'LGTM')).toBeNull()
  })

  describe('commitJustFailed override', () => {
    it('allows retry when commit failed even with no recorded changes', () => {
      expect(computePushBlockReason(0, false, 'LGTM', true)).toBeNull()
    })

    it('allows retry when commit failed and files look unreviewed (hook modified files)', () => {
      expect(computePushBlockReason(3, true, 'LGTM', true)).toBeNull()
    })

    it('allows retry when commit failed and verdict is missing', () => {
      expect(computePushBlockReason(3, false, null, true)).toBeNull()
    })

    it('allows retry when commit failed even with unreviewed changes and no verdict', () => {
      expect(computePushBlockReason(3, true, null, true)).toBeNull()
    })

    it('does NOT allow retry when verdict is explicitly bad and commit has not failed', () => {
      expect(computePushBlockReason(3, false, 'DO NOT SHIP', false)).toBe(
        'Review verdict is "DO NOT SHIP" — fix issues before pushing',
      )
    })
  })
})
