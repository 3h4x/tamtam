'use client'

import type { ReactNode } from 'react'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: ReactNode
}

export interface SegmentedControlProps<T extends string> {
  options: Array<SegmentedControlOption<T>>
  value: T
  ariaLabel: string
  className?: string
  disabled?: boolean
  onChange: (value: T) => void
}

export function SegmentedControl<T extends string>({
  options,
  value,
  ariaLabel,
  className = '',
  disabled = false,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`flex items-center gap-0.5 overflow-hidden rounded border border-border ${className}`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            className={`cursor-pointer border-none px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              active
                ? 'bg-accent text-white'
                : 'bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
            }`}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
