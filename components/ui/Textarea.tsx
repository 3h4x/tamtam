'use client'

import React from 'react'

// Canonical multi-line text-input styling shared across agent/config/skill forms.
// Mirrors Input's composable API: `appearance="default"` is the inset bg-primary
// field (matches Input and most settings/config textareas); `appearance="elevated"`
// is the raised bg-secondary field used by the agent prompt editor;
// `appearance="muted"` is the inset bg-tertiary field (matches Input's `muted`,
// used by the skill prompt editor). `inputSize`
// switches between the comfortably-rounded (default) and tighter compact field;
// `fontSize` switches the base `text-sm` to `text-xs` for dense forms.
// Pass `className` to extend (appended last); note there is no tailwind-merge, so
// overriding a base utility that conflicts won't win — prefer leaving genuinely
// different textareas raw.
const TEXTAREA_BASE =
  'w-full px-3 border border-border text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed'

const FONT_SIZE_CLASSES: Record<'sm' | 'xs', string> = {
  sm: 'text-sm',
  xs: 'text-xs',
}

const APPEARANCE_CLASSES: Record<'default' | 'elevated' | 'muted', string> = {
  default: 'bg-bg-primary focus:ring-2 focus:ring-accent/30',
  elevated: 'bg-bg-secondary focus:ring-2 focus:ring-accent/40',
  muted: 'bg-bg-tertiary focus:ring-2 focus:ring-accent/30',
}

const SIZE_CLASSES: Record<'default' | 'compact', string> = {
  default: 'py-2 rounded-lg',
  compact: 'py-1.5 rounded-md',
}

const FONT_CLASSES: Record<'mono' | 'sans', string> = {
  mono: 'font-mono',
  sans: 'font-sans',
}

const RESIZE_CLASSES: Record<'y' | 'both' | 'none', string> = {
  y: 'resize-y',
  both: 'resize',
  none: 'resize-none',
}

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  appearance?: 'default' | 'elevated' | 'muted'
  inputSize?: 'default' | 'compact'
  fontFamily?: 'mono' | 'sans'
  fontSize?: 'sm' | 'xs'
  resize?: 'y' | 'both' | 'none'
  ref?: React.Ref<HTMLTextAreaElement>
}

export function Textarea({
  className,
  appearance = 'default',
  inputSize = 'default',
  fontFamily = 'mono',
  fontSize = 'sm',
  resize = 'y',
  ref,
  ...props
}: TextareaProps) {
  return (
    <textarea
      ref={ref}
      className={[
        TEXTAREA_BASE,
        APPEARANCE_CLASSES[appearance],
        SIZE_CLASSES[inputSize],
        FONT_CLASSES[fontFamily],
        FONT_SIZE_CLASSES[fontSize],
        RESIZE_CLASSES[resize],
        className,
      ].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
