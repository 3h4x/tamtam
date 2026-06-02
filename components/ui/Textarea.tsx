'use client'

import React from 'react'

// Canonical multi-line text-input styling shared across agent/config/skill forms:
// full-width, mono, resizable, with the standard accent focus ring and disabled
// affordances. Pass `className` to extend (appended last); note there is no
// tailwind-merge, so overriding a base utility that conflicts won't win — prefer
// leaving genuinely different textareas raw.
const TEXTAREA_BASE =
  'w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-y disabled:opacity-60 disabled:cursor-not-allowed'

const FONT_CLASSES: Record<'mono' | 'sans', string> = {
  mono: 'font-mono',
  sans: 'font-sans',
}

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  fontFamily?: 'mono' | 'sans'
  ref?: React.Ref<HTMLTextAreaElement>
}

export function Textarea({ className, fontFamily = 'mono', ref, ...props }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      className={[TEXTAREA_BASE, FONT_CLASSES[fontFamily], className].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
