'use client'

import type { ReactNode } from 'react'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
}

export interface SegmentedControlProps<T extends string> {
  options: Array<SegmentedControlOption<T>>
  value: T
  ariaLabel: string
  className?: string
  disabled?: boolean
  size?: 'xs' | 'sm'
  tone?: 'default' | 'current'
  onChange: (value: T) => void
}

export function SegmentedControl<T extends string>({
  options,
  value,
  ariaLabel,
  className = '',
  disabled = false,
  size = 'sm',
  tone = 'default',
  onChange,
}: SegmentedControlProps<T>) {
  const containerTone =
    tone === 'current'
      ? 'border-current/20'
      : 'border-border'
  const buttonSize =
    size === 'xs'
      ? 'px-2 py-0.5'
      : 'px-2.5 py-1'

  return (
    <div
      className={`flex items-center gap-0.5 overflow-hidden rounded border ${containerTone} ${className}`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = option.value === value
        const buttonTone =
          tone === 'current'
            ? active
              ? 'bg-current/20 text-current'
              : 'bg-transparent text-current/50 hover:text-current/80'
            : active
              ? 'bg-accent text-white'
              : 'bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            title={option.title}
            className={`cursor-pointer border-none ${buttonSize} text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${buttonTone}`}
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
