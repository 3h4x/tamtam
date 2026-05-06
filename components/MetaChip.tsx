'use client'

import React from 'react'

export function MetaChip({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: React.ReactNode
  tone?: 'neutral' | 'accent'
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-mono ${
      tone === 'accent'
        ? 'border-accent/25 bg-accent/10 text-accent'
        : 'border-border bg-bg-primary/70 text-text-secondary'
    }`}>
      <span className="text-text-tertiary">{label}</span>
      <span className={tone === 'accent' ? 'text-accent' : 'text-text-primary'}>{value}</span>
    </span>
  )
}
