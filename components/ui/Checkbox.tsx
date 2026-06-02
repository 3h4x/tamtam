'use client'

import React from 'react'

// Canonical checkbox styling shared across settings/config forms: fixed 1rem
// square and rounded. Two visual variants:
// - `default`: custom-look box with border/bg and an accent focus ring.
// - `native`: native control tinted via CSS `accent-color`, used in inline
//   toggle rows where the box sits next to a label and shouldn't shrink.
// Pass `className` to extend (appended last); note there is no tailwind-merge, so
// overriding a base utility that conflicts won't win — prefer leaving genuinely
// different checkboxes raw.
const CHECKBOX_BASE: Record<'default' | 'native', string> = {
  default: 'h-4 w-4 rounded border-border bg-bg-primary text-accent focus:ring-accent/30',
  native: 'w-4 h-4 accent-accent rounded shrink-0 cursor-pointer',
}

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  variant?: 'default' | 'native'
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={[CHECKBOX_BASE[variant], className].filter(Boolean).join(' ')}
      {...props}
    />
  ),
)
Checkbox.displayName = 'Checkbox'
