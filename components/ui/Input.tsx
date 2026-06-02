'use client'

import React from 'react'

// Canonical text-input styling shared across settings/config forms: full-width,
// mono, with the standard accent focus ring. `size="default"` is the fixed-height
// (h-10), comfortably rounded settings field; `size="compact"` is the shorter,
// tighter-radius config-form field. Pass `className` to extend (appended last);
// note there is no tailwind-merge, so overriding a base utility that conflicts
// won't win — prefer leaving genuinely different inputs raw.
const INPUT_BASE =
  'px-3 bg-bg-primary text-text-primary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono'

const SIZE_CLASSES: Record<'default' | 'compact', string> = {
  default: 'h-10 py-2 rounded-lg',
  compact: 'py-1.5 rounded-md',
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  inputSize?: 'default' | 'compact'
  fullWidth?: boolean
}

export function Input({ className, inputSize = 'default', fullWidth = true, ...props }: InputProps) {
  return (
    <input
      className={[fullWidth ? 'w-full' : null, INPUT_BASE, SIZE_CLASSES[inputSize], className].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
