'use client'

import React from 'react'

// Canonical color swatch input for project custom-action colors.
// Keep this intentionally narrow: browser-native color picking, fixed compact
// swatch dimensions, and the standard border/background tokens.
export interface ColorInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  ref?: React.Ref<HTMLInputElement>
}

export function ColorInput({ className, ref, ...props }: ColorInputProps) {
  return (
    <input
      ref={ref}
      type="color"
      className={[
        'h-8 w-10 cursor-pointer rounded-md border border-border bg-bg-primary p-0.5',
        className,
      ].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
