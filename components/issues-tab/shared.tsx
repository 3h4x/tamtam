'use client'

import { Spinner } from '@/components/ui/Spinner'
import { Pill, PillButton } from '@/components/ui/Pill'
import type { GhLabel } from '@/lib/client-api'
import type { GateState, PrGates } from '@/lib/github/issue-row-enrichment'

export function Labels({ labels, limit }: { labels: GhLabel[]; limit?: number }) {
  if (!labels.length) return null
  const visible = typeof limit === 'number' ? labels.slice(0, limit) : labels
  const hidden = labels.length - visible.length
  return (
    <span className="flex flex-wrap items-center gap-1">
      {visible.map((l) => (
        <span
          key={l.name}
          className="rounded-full px-1.5 py-0.5 text-[9px] font-medium"
          style={{ background: `#${l.color}22`, color: `#${l.color}`, border: `1px solid #${l.color}44` }}
        >
          {l.name}
        </span>
      ))}
      {hidden > 0 && (
        <Pill
          size="xs"
          className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[9px] font-medium text-text-tertiary"
          title={labels.slice(visible.length).map((l) => l.name).join(', ')}
        >
          +{hidden}
        </Pill>
      )}
    </span>
  )
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export function CheckIcon({ conclusion, status }: { conclusion: string | null; status: string }) {
  const ok = conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED'
  const pending = status !== 'COMPLETED'
  if (pending) return (
    <Spinner size="sm" shrink className="opacity-70" />
  )
  if (ok) return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
    </svg>
  )
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
    </svg>
  )
}

export type { GateState, PrGates }

export const GATE_CLASS: Record<GateState, string> = {
  pass: 'bg-status-success/10 text-status-success border-status-success/30',
  fail: 'bg-status-error/10 text-status-error border-status-error/30',
  warn: 'bg-status-warning/10 text-status-warning border-status-warning/30',
  none: 'bg-bg-tertiary text-text-tertiary border-border',
}
export const GATE_SYMBOL: Record<GateState, string> = { pass: '✓', fail: '✗', warn: '!', none: '○' }

export function GateBadge({
  label,
  state,
  title,
  onClick,
  busy,
  disabled,
}: {
  label: string
  state: GateState
  title: string
  onClick?: () => void
  busy?: boolean
  disabled?: boolean
}) {
  const cls = `inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${GATE_CLASS[state]} ${onClick && !disabled ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`
  if (onClick) {
    return (
      <PillButton
        type="button"
        className={cls}
        title={title}
        onClick={(e) => { e.stopPropagation(); if (!busy && !disabled) onClick() }}
        disabled={busy || disabled}
      >
        <span>{busy ? '⟳' : GATE_SYMBOL[state]}</span>
        <span>{label}</span>
      </PillButton>
    )
  }
  return (
    <Pill className={cls} title={title}>
      <span>{GATE_SYMBOL[state]}</span>
      <span>{label}</span>
    </Pill>
  )
}
