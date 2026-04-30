'use client'

import type { GhLabel } from '@/lib/client-api'

export function Labels({ labels }: { labels: GhLabel[] }) {
  if (!labels.length) return null
  return (
    <span className="flex items-center gap-1 flex-wrap">
      {labels.map((l) => (
        <span
          key={l.name}
          className="px-1.5 py-0.5 text-[10px] rounded-full font-medium"
          style={{ background: `#${l.color}22`, color: `#${l.color}`, border: `1px solid #${l.color}44` }}
        >
          {l.name}
        </span>
      ))}
    </span>
  )
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export function CheckIcon({ conclusion, status }: { conclusion: string | null; status: string }) {
  const ok = conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED'
  const pending = status !== 'COMPLETED'
  if (pending) return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin opacity-70">
      <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 14A6 6 0 118 2a6 6 0 010 12z" opacity=".3"/>
      <path d="M8 2a6 6 0 016 6h-2A4 4 0 008 4V2z"/>
    </svg>
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

export type GateState = 'pass' | 'fail' | 'warn' | 'none'
export type PrGates = { issueNumber: number | null; tests: GateState; review: GateState; dod: GateState; dodSummary: string | null }

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
}: {
  label: string
  state: GateState
  title: string
  onClick?: () => void
  busy?: boolean
}) {
  const cls = `inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${GATE_CLASS[state]} ${onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        title={title}
        onClick={(e) => { e.stopPropagation(); if (!busy) onClick() }}
        disabled={busy}
      >
        <span>{busy ? '⟳' : GATE_SYMBOL[state]}</span>
        <span>{label}</span>
      </button>
    )
  }
  return (
    <span className={cls} title={title}>
      <span>{GATE_SYMBOL[state]}</span>
      <span>{label}</span>
    </span>
  )
}
