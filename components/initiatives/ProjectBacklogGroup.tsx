'use client'

import { useState } from 'react'
import type { InitiativesListResponse } from '@/app/api/initiatives/route'
import type { InitiativeAction } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'

type Row = InitiativesListResponse['initiatives'][number]

// How many initiatives to show per project before collapsing the rest.
const TOP = 3

// Statuses the operator can still curate (promote/reject). Terminal/in-flight
// rows render read-only.
const CURATABLE = new Set(['proposed', 'queued'])
const STATUS_TONE: Record<string, string> = {
  proposed: 'text-text-secondary',
  queued: 'text-accent',
  running: 'text-status-warning',
  shipped: 'text-status-success',
  failed: 'text-status-error',
  rejected: 'text-text-tertiary',
  superseded: 'text-text-tertiary',
}

function ago(ms: number): string {
  if (!ms) return '—'
  const m = Math.floor((Date.now() - ms) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// Pinned first, then actionable (queued/proposed) ahead of terminal rows, then
// by score — so the top-N a project shows is its most relevant open work.
function rank(a: Row, b: Row): number {
  const pin = (b.pinnedAt ? 1 : 0) - (a.pinnedAt ? 1 : 0)
  if (pin !== 0) return pin
  const act = (CURATABLE.has(a.status) ? 0 : 1) - (CURATABLE.has(b.status) ? 0 : 1)
  if (act !== 0) return act
  return b.score - a.score
}

function BacklogItem({ r, act }: { r: Row; act: (id: number, action: InitiativeAction) => void }) {
  const pinned = r.pinnedAt != null
  const rejected = r.status === 'rejected'
  const curatable = CURATABLE.has(r.status)
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <span className="rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-bg-tertiary text-text-secondary shrink-0">
        {r.kind}
      </span>
      <span className="flex-1 min-w-0 text-xs text-text-primary truncate" title={r.title}>
        {pinned && <span className="mr-1 text-accent" aria-label="pinned">📌</span>}
        {r.title}
      </span>
      <span className={`text-[11px] shrink-0 ${STATUS_TONE[r.status] ?? 'text-text-secondary'}`}>{r.status}</span>
      <span className="text-[11px] font-mono tabular-nums text-text-secondary shrink-0 w-8 text-right">
        {r.score > 0 ? r.score.toFixed(0) : '—'}
      </span>
      <span className="text-[11px] tabular-nums text-text-tertiary shrink-0 w-8 text-right">{ago(r.updatedAt)}</span>
      <span className="flex items-center gap-1 justify-end shrink-0 w-12">
        {rejected ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-[11px] !text-text-tertiary hover:!text-text-primary hover:no-underline"
            onClick={() => act(r.id, 'restore')}
          >undo</Button>
        ) : curatable ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={pinned ? 'Un-pin' : 'Promote'}
              title={pinned ? 'Un-pin' : 'Promote to top'}
              className={`h-auto w-auto rounded p-0 text-sm hover:bg-transparent ${pinned ? 'opacity-100' : 'opacity-40 hover:opacity-100'}`}
              onClick={() => act(r.id, pinned ? 'unpromote' : 'promote')}
            >👍</Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Reject"
              title="Reject"
              className="h-auto w-auto rounded p-0 text-sm opacity-40 hover:bg-transparent hover:opacity-100"
              onClick={() => act(r.id, 'reject')}
            >👎</Button>
          </>
        ) : null}
      </span>
    </li>
  )
}

// One project's backlog: its top-ranked initiatives, collapsed to TOP with a
// "show N more" expander so a high-issue repo doesn't flood the list.
export function ProjectBacklogGroup({
  project,
  rows,
  act,
}: {
  project: string
  rows: Row[]
  act: (id: number, action: InitiativeAction) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const ranked = [...rows].sort(rank)
  const visible = expanded ? ranked : ranked.slice(0, TOP)
  const hidden = ranked.length - visible.length
  const showExpander = expanded || hidden > 0

  return (
    <div className="border border-border rounded-lg bg-bg-primary overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-bg-secondary border-b border-border">
        <span className="text-xs font-medium text-text-primary" data-private>{project}</span>
        <span className="text-[10px] font-mono text-text-tertiary tabular-nums">{ranked.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {visible.map((r) => <BacklogItem key={r.id} r={r} act={act} />)}
      </ul>
      {showExpander && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-center rounded-none border-t border-border px-3 py-1.5 text-[11px] text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? 'show less' : `show ${hidden} more`}
        </Button>
      )}
    </div>
  )
}
