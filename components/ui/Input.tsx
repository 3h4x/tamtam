'use client'

import React from 'react'

// Canonical text-input styling shared across settings/config forms: full-width,
// fixed-height, mono, with the standard accent focus ring. Pass `className` to
// extend (appended last); note there is no tailwind-merge, so overriding a base
// utility that conflicts won't win — prefer leaving genuinely different inputs raw.
const INPUT_BASE =
  'w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors font-mono'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function Input({ className, ...props }: InputProps) {
  return <input className={[INPUT_BASE, className].filter(Boolean).join(' ')} {...props} />
}
