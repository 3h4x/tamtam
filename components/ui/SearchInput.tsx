'use client'

import React from 'react'

// Canonical search/filter field used in page and panel headers (skills, agent
// catalog, etc.): full-width up to a comfortable cap, secondary surface, sans
// font, softer accent focus ring. Distinct from `Input` (form field: mono,
// fixed-height, primary surface). Pass `className` to extend (appended last);
// there is no tailwind-merge, so don't override a conflicting base utility.
const SEARCH_BASE =
  'w-full sm:max-w-md px-3 py-2 text-sm bg-bg-secondary border border-border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors'

export interface SearchInputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function SearchInput({ className, type = 'search', ...props }: SearchInputProps) {
  return <input type={type} className={[SEARCH_BASE, className].filter(Boolean).join(' ')} {...props} />
}
