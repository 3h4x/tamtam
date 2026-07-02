import { describe, it, expect } from 'vitest'
import { formatTokens, formatCost } from '@/components/project-runs/formatting'

describe('formatTokens', () => {
  it('scales through k / M / B', () => {
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(1_500)).toBe('1.5k')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    // Previously rendered as the nonsense "1400.0M".
    expect(formatTokens(1_400_000_000)).toBe('1.4B')
  })
})

describe('formatCost', () => {
  it('formats zero, sub-cent, and dollar amounts', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(0.00005)).toBe('<$0.0001')
    expect(formatCost(1.234)).toBe('$1.23')
  })
})
