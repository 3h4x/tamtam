'use client'

import React from 'react'

// Canonical <select> styling shared across settings/config forms: full-width,
// fixed-height, with the standard accent focus ring and a custom chevron via an
// inline SVG background. Pass `className` to extend (appended last); note there
// is no tailwind-merge, so overriding a base utility that conflicts won't win —
// prefer leaving genuinely different selects raw.
const SELECT_BASE =
  'w-full h-10 px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors appearance-none cursor-pointer bg-no-repeat bg-[right_0.6rem_center] pr-9 bg-[length:1rem] bg-[image:url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23888%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M6%209l6%206%206-6%27%2F%3E%3C%2Fsvg%3E")]'

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export function Select({ className, ...props }: SelectProps) {
  return <select className={[SELECT_BASE, className].filter(Boolean).join(' ')} {...props} />
}
