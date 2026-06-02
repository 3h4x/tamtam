'use client'

import React from 'react'

// Canonical checkbox styling shared across settings/config forms: fixed 1rem
// square, rounded, with the standard accent fill and focus ring. Pass `className`
// to extend (appended last); note there is no tailwind-merge, so overriding a base
// utility that conflicts won't win — prefer leaving genuinely different checkboxes raw.
const CHECKBOX_BASE = 'h-4 w-4 rounded border-border bg-bg-primary text-accent focus:ring-accent/30'

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {}

export function Checkbox({ className, ...props }: CheckboxProps) {
  return <input type="checkbox" className={[CHECKBOX_BASE, className].filter(Boolean).join(' ')} {...props} />
}
