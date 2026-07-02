import { describe, it, expect } from 'vitest'
import { formatDurationMs } from '@/lib/shared/format'

describe('formatDurationMs', () => {
  it('scales ms → s → m s → h m', () => {
    expect(formatDurationMs(230)).toBe('230ms')
    expect(formatDurationMs(45_000)).toBe('45s')
    expect(formatDurationMs(192_000)).toBe('3m 12s')
    expect(formatDurationMs(180_000)).toBe('3m')
    expect(formatDurationMs(3_840_000)).toBe('1h 4m')
  })
  it('returns the empty sentinel for null / non-positive', () => {
    expect(formatDurationMs(null)).toBe('')
    expect(formatDurationMs(0)).toBe('')
    expect(formatDurationMs(-5)).toBe('')
    expect(formatDurationMs(null, '—')).toBe('—')
  })
})
