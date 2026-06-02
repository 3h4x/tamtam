'use client'

import React from 'react'

// Canonical text-input styling shared across settings/config forms: full-width,
// mono, with the standard accent focus ring. `size="default"` is the fixed-height
// (h-10), comfortably rounded settings field; `size="compact"` is the shorter,
// tighter-radius config-form field. Pass `className` to extend (appended last);
// note there is no tailwind-merge, so overriding a base utility that conflicts
// won't win — prefer leaving genuinely different inputs raw.
const INPUT_BASE =
  'border border-border text-sm transition-colors'

const APPEARANCE_CLASSES: Record<'default' | 'muted', string> = {
  default: 'bg-bg-primary text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent',
  muted: 'bg-bg-tertiary text-text-secondary',
}

const SIZE_CLASSES: Record<'default' | 'compact', string> = {
  default: 'h-10 py-2 rounded-lg',
  compact: 'py-1.5 rounded-md',
}

const FONT_CLASSES: Record<'mono' | 'sans', string> = {
  mono: 'font-mono',
  sans: 'font-sans',
}

const PADDING_X_CLASSES: Record<'default' | 'compact', string> = {
  default: 'px-3',
  compact: 'px-2.5',
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  inputSize?: 'default' | 'compact'
  fullWidth?: boolean
  fontFamily?: 'mono' | 'sans'
  paddingX?: 'default' | 'compact'
  appearance?: 'default' | 'muted'
}

export function Input({
  className,
  inputSize = 'default',
  fullWidth = true,
  fontFamily = 'mono',
  paddingX = 'default',
  appearance = 'default',
  ...props
}: InputProps) {
  return (
    <input
      className={[
        fullWidth ? 'w-full' : null,
        INPUT_BASE,
        APPEARANCE_CLASSES[appearance],
        SIZE_CLASSES[inputSize],
        FONT_CLASSES[fontFamily],
        PADDING_X_CLASSES[paddingX],
        className,
      ].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
