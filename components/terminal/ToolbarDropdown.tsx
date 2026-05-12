'use client'

import React, { useEffect, useRef, useState } from 'react'

export interface ToolbarDropdownOption<V extends string> {
  value: V
  label: string
  description?: string
  hint?: string
}

interface ToolbarDropdownProps<V extends string> {
  label: string
  value: V
  options: ToolbarDropdownOption<V>[]
  onChange: (value: V) => void
  disabled?: boolean
  disabledTitle?: string
  align?: 'left' | 'right'
  width?: string
}

export function ToolbarDropdown<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  disabledTitle,
  align = 'right',
  width = 'w-56',
}: ToolbarDropdownProps<V>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find(o => o.value === value)

  return (
    <div className="toolbar-group" ref={rootRef}>
      <span className="toolbar-label">{label}</span>
      <div className="relative">
        <button
          type="button"
          className={`toolbar-tab toolbar-dropdown-trigger${open ? ' active' : ''}`}
          onClick={() => !disabled && setOpen(v => !v)}
          disabled={disabled}
          title={disabled ? disabledTitle : current?.description || current?.label}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="lowercase leading-none">{current?.label ?? value}</span>
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            aria-hidden="true"
            className="text-text-tertiary/80 shrink-0"
          >
            <path d="M2.5 4 L5 6.5 L7.5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div
            className={`absolute top-full mt-1 ${align === 'right' ? 'right-0' : 'left-0'} ${width} bg-bg-secondary border border-border rounded-lg shadow-lg z-50 overflow-hidden`}
            role="listbox"
          >
            {options.map(opt => {
              const selected = opt.value === value
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`w-full border-none px-3 py-2 text-left cursor-pointer font-mono transition-colors ${
                    selected
                      ? 'bg-accent/10 hover:bg-accent/15 text-accent'
                      : 'hover:bg-bg-tertiary bg-transparent text-text-primary'
                  }`}
                  onClick={() => { onChange(opt.value); setOpen(false) }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex items-start gap-2">
                      <span className="mt-0.5 shrink-0 w-3 text-center text-[10px]">{selected ? '✓' : ''}</span>
                      <div className="min-w-0">
                        <div className="truncate text-xs">{opt.label}</div>
                        {opt.description && (
                          <div className="mt-0.5 truncate text-[10px] text-text-tertiary">
                            {opt.description}
                          </div>
                        )}
                      </div>
                    </div>
                    {opt.hint && (
                      <span className="shrink-0 text-[10px] text-text-tertiary/60">{opt.hint}</span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
