'use client'

import React from 'react'

// Canonical checkbox styling shared across settings/config forms: rounded box in
// one of two sizes. Two visual variants:
// - `default`: custom-look box with border/bg and an accent focus ring.
// - `native`: native control tinted via CSS `accent-color`, used in inline
//   toggle rows where the box sits next to a label and shouldn't shrink.
// `size` controls the square dimension: `default` (1rem) or `sm` (0.875rem) for
// compact inline toggles.
// Pass `className` to extend (appended last); note there is no tailwind-merge, so
// overriding a base utility that conflicts won't win — prefer leaving genuinely
// different checkboxes raw.
const CHECKBOX_SIZE: Record<'default' | 'sm', string> = {
  default: 'h-4 w-4',
  sm: 'h-3.5 w-3.5',
}
const CHECKBOX_VARIANT: Record<'default' | 'native', string> = {
  default: 'rounded border-border bg-bg-primary text-accent focus:ring-accent/30',
  native: 'accent-accent rounded shrink-0 cursor-pointer',
}

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  variant?: 'default' | 'native'
  size?: 'default' | 'sm'
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={[CHECKBOX_SIZE[size], CHECKBOX_VARIANT[variant], className].filter(Boolean).join(' ')}
      {...props}
    />
  ),
)
Checkbox.displayName = 'Checkbox'
