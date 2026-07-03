'use client'

import { Spinner } from '@/components/ui/Spinner'
import { Pill, PillButton } from '@/components/ui/Pill'
import type { GhLabel, ProjectConfig } from '@/lib/client-api'
import type { GateState, PrGates } from '@/lib/github/issue-row-enrichment'

// Build the hover tooltip / summary for the "Work on" affordance — an ordered
// list of steps that will actually fire, with skipped ones marked "(off)".
// Kept in sync with the Config → When you click Work on section. Shared by the
// issue row button and the issue detail drawer.
export function workOnChainSummary(cfg: ProjectConfig | null): string {
  const on = (b: boolean | undefined) => b === true
  const step = (label: string, enabled: boolean) => `${enabled ? '✓' : '○'} ${label}${enabled ? '' : ' (off)'}`
  const parts = [
    step('branch', cfg ? on(cfg.issue_auto_branch) : true),
    '✓ prompt',
    step('release chain', on(cfg?.release_after_run)),
    step('auto-commit', on(cfg?.auto_commit_enabled)),
    step('auto-push + PR', on(cfg?.auto_push_enabled)),
    step('auto-merge + DoD', on(cfg?.auto_pr_merge_enabled)),
  ]
  return `Work-on pipeline:\n${parts.join('\n')}\n\nChange these in Config → When you click Work on.`
}

// Map a GitHub label to a token-based status dot by priority, instead of
// rendering its arbitrary repo-defined hex (which breaks the one-accent /
// 4-status color system). The label text itself stays a neutral pill; the dot
// carries the operator-actionable priority signal (status color + icon).
function priorityDot(name: string): string | null {
  const n = name.toLowerCase()
  if (/priority:\s*high|(^|[^a-z])(high|critical|urgent|blocker|p0|security)([^a-z]|$)/.test(n)) return 'bg-status-error'
  if (/priority:\s*medium|(^|[^a-z])(medium|human-needed|p1)([^a-z]|$)/.test(n)) return 'bg-status-warning'
  if (/priority:\s*low|(^|[^a-z])(low|p2)([^a-z]|$)/.test(n)) return 'bg-status-info'
  return null
}

export function Labels({ labels, limit }: { labels: GhLabel[]; limit?: number }) {
  if (!labels.length) return null
  const visible = typeof limit === 'number' ? labels.slice(0, limit) : labels
  const hidden = labels.length - visible.length
  return (
    <span className="flex flex-wrap items-center gap-1">
      {visible.map((l) => {
        const dot = priorityDot(l.name)
        return (
          <span
            key={l.name}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-1.5 py-0.5 text-[9px] font-medium text-text-secondary"
          >
            {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />}
            {l.name}
          </span>
        )
      })}
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
