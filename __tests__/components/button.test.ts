import { describe, it, expect } from 'vitest'
import { buttonVariants } from '@/components/ui/Button'

describe('buttonVariants', () => {
  it('defaults to secondary variant and md size', () => {
    const cls = buttonVariants()
    expect(cls).toContain('border-border')
    expect(cls).toContain('px-3')
    expect(cls).toContain('text-sm')
  })

  it('applies primary variant classes', () => {
    const cls = buttonVariants({ variant: 'primary' })
    expect(cls).toContain('border-accent')
    expect(cls).toContain('text-accent')
    expect(cls).not.toContain('border-border')
  })

  it('applies solid variant classes', () => {
    const cls = buttonVariants({ variant: 'solid' })
    expect(cls).toContain('bg-accent')
    expect(cls).toContain('text-white')
  })

  it('applies danger-solid variant classes', () => {
    const cls = buttonVariants({ variant: 'danger-solid' })
    expect(cls).toContain('bg-status-error')
    expect(cls).toContain('text-white')
  })

  it('applies sm size classes', () => {
    const cls = buttonVariants({ size: 'sm' })
    expect(cls).toContain('px-2')
    expect(cls).toContain('text-xs')
    expect(cls).not.toContain('px-3')
  })

  it('appends extra className', () => {
    const cls = buttonVariants({ className: 'my-extra-class' })
    expect(cls).toContain('my-extra-class')
  })

  it('omits undefined className gracefully', () => {
    const cls = buttonVariants({ className: undefined })
    expect(cls).not.toContain('undefined')
  })

  it('always includes base inline-flex and transition-colors', () => {
    for (const variant of ['secondary', 'primary', 'solid', 'ghost', 'danger', 'danger-solid', 'warning', 'info'] as const) {
      const cls = buttonVariants({ variant })
      expect(cls).toContain('inline-flex')
      expect(cls).toContain('transition-colors')
    }
  })
})
