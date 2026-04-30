'use client'

import { useState } from 'react'

export interface SchedulerInternalEntry {
  agentId: string
  project: string
  name: string
  schedule: string
  enabled: boolean
  nextFireMs: number
  lastFireMs: number | null
  lastJobMs: number | null
  fireCount: number
  errorCount: number
  lastError: string | null
}

function fmtRelative(ms: number | null, now: number): string {
  if (ms === null) return 'never'
  const diff = ms - now
  const abs = Math.abs(diff)
  const sec = Math.round(abs / 1000)
  const min = Math.round(sec / 60)
  const hr = Math.round(min / 60)
  let label: string
  if (sec < 60) label = `${sec}s`
  else if (min < 60) label = `${min}m`
  else if (hr < 48) label = `${hr}h`
  else label = `${Math.round(hr / 24)}d`
  return diff < 0 ? `${label} ago` : `in ${label}`
}

export function SchedulerFireTable({ entries }: { entries: SchedulerInternalEntry[] }) {
  const [showAll, setShowAll] = useState(false)
  const now = Date.now()
  const sorted = [...entries].sort((a, b) => {
    if (a.lastError && !b.lastError) return -1
    if (!a.lastError && b.lastError) return 1
    return a.nextFireMs - b.nextFireMs
  })
  const overdue = sorted.filter(e => e.nextFireMs < now)
  const visible = showAll ? sorted : sorted.slice(0, 8)

  return (
    <div>
      <h3 className="text-xs font-medium text-text-secondary mb-1">
        Fire history
        {overdue.length > 0 && (
          <span className="ml-2 text-status-warning">({overdue.length} overdue)</span>
        )}
      </h3>
      <div className="rounded-md border border-border overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-tertiary border-b border-border bg-bg-secondary/30">
          <span>Agent</span>
          <span>Sched</span>
          <span>Next</span>
          <span>Last</span>
          <span>Fires</span>
        </div>
        {visible.map(e => {
          const isOverdue = e.nextFireMs < now
          const hasError = !!e.lastError
          return (
            <div
              key={e.agentId}
              className={`grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-3 py-1.5 text-xs font-mono border-t border-border first:border-t-0 ${hasError ? 'bg-status-error/5' : ''}`}
              title={e.lastError ?? ''}
            >
              <span className="text-text-primary truncate" data-private>{e.project}/{e.name}</span>
              <span className="text-text-tertiary">{e.schedule}</span>
              <span className={isOverdue ? 'text-status-warning' : 'text-text-secondary'}>{fmtRelative(e.nextFireMs, now)}</span>
              <span className={(e.lastJobMs ?? e.lastFireMs) === null ? 'text-text-tertiary' : 'text-text-secondary'}>{fmtRelative(e.lastJobMs ?? e.lastFireMs, now)}</span>
              <span className={e.errorCount > 0 ? 'text-status-error' : 'text-text-secondary'}>
                {e.fireCount}{e.errorCount > 0 ? `/${e.errorCount}!` : ''}
              </span>
            </div>
          )
        })}
      </div>
      {sorted.length > 8 && (
        <button
          onClick={() => setShowAll(v => !v)}
          className="mt-1 text-[11px] text-text-tertiary hover:text-text-secondary cursor-pointer"
        >
          {showAll ? 'Show less' : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  )
}
