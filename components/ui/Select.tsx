'use client'

import React from 'react'

// Canonical <select> styling shared across settings/config forms: full-width,
// fixed-height, with the standard accent focus ring and a custom chevron via an
// inline SVG background. Pass `className` to extend non-conflicting utilities.
const SELECT_BASE =
  'w-full h-10 px-3 py-2 text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-accent transition-colors appearance-none cursor-pointer bg-no-repeat bg-[right_0.6rem_center] pr-9 bg-[length:1rem] bg-[image:url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23888%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M6%209l6%206%206-6%27%2F%3E%3C%2Fsvg%3E")]'

const SURFACE_CLASSES = {
  primary: 'bg-bg-primary',
  secondary: 'bg-bg-secondary',
} as const

const FOCUS_RING_CLASSES = {
  default: 'focus:ring-accent/30',
  strong: 'focus:ring-accent/40',
} as const

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  surface?: keyof typeof SURFACE_CLASSES
  focusRing?: keyof typeof FOCUS_RING_CLASSES
}

export function Select({ className, surface = 'primary', focusRing = 'default', ...props }: SelectProps) {
  return (
    <select
      className={[SELECT_BASE, SURFACE_CLASSES[surface], FOCUS_RING_CLASSES[focusRing], className].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
