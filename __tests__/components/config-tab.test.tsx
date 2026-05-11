/* @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'
import { normalizeActionColorForPicker } from '@/components/project-detail/ConfigTab'

describe('normalizeActionColorForPicker', () => {
  it('maps legacy named colors to picker-safe hex values', () => {
    expect(normalizeActionColorForPicker('green')).toBe('#16a34a')
    expect(normalizeActionColorForPicker('blue')).toBe('#2563eb')
  })

  it('preserves hex colors and expands shorthand values', () => {
    expect(normalizeActionColorForPicker('#123456')).toBe('#123456')
    expect(normalizeActionColorForPicker('#abc')).toBe('#aabbcc')
  })

  it('falls back to the default color for empty or invalid values', () => {
    expect(normalizeActionColorForPicker('')).toBe('#2563eb')
    expect(normalizeActionColorForPicker('not-a-color')).toBe('#2563eb')
    expect(normalizeActionColorForPicker(undefined)).toBe('#2563eb')
  })
})
