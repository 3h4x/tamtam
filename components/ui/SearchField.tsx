'use client'

import React from 'react'
import { Button } from '@/components/ui/Button'

// Shared search/filter input: a relative wrapper holding a text input, an
// optional leading glyph, and a clear (×) Button that appears once there is a
// value. The exact input styling differs slightly between call sites (focus
// ring, leading-glyph padding), so it stays caller-controlled via
// `inputClassName`; this component consolidates the repeated wrapper + clear
// Button structure rather than imposing one canonical input look.
interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  inputClassName?: string
  wrapperClassName?: string
  leadingGlyph?: React.ReactNode
  clearLabel?: string
}

export function SearchField({
  value,
  onChange,
  placeholder,
  inputClassName,
  wrapperClassName,
  leadingGlyph,
  clearLabel = 'Clear search',
}: SearchFieldProps) {
  return (
    <div className={wrapperClassName ? `relative ${wrapperClassName}` : 'relative'}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClassName}
      />
      {leadingGlyph ? (
        <span
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary text-xs"
          aria-hidden
        >
          {leadingGlyph}
        </span>
      ) : null}
      {value ? (
        <Button
          type="button"
          onClick={() => onChange('')}
          variant="ghost"
          size="icon-sm"
          className="absolute right-1.5 top-1/2 -translate-y-1/2"
          aria-label={clearLabel}
          title={clearLabel}
        >
          ×
        </Button>
      ) : null}
    </div>
  )
}
