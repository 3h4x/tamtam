'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { InitiativesListResponse } from '@/app/api/initiatives/route'
import type { ProjectsResponse } from '@/lib/shared/types'
import { fetchProjects } from '@/lib/client/projects'
import { patchInitiative, type InitiativeAction } from '@/lib/client-api'
import { Table } from '@/components/ui/Table'
import type { Column } from '@/components/ui/Table'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { ProjectPreviewRow } from '@/components/initiatives/ProjectPreviewRow'

// epoch-milliseconds → "Xm ago" / "Xh ago" / "Xd ago"
function fmtAgo(epochMs: number): string {
  if (!epochMs) return '—'
  const m = Math.floor((Date.now() - epochMs) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const STATUS_TONE: Record<string, string> = {
  proposed: 'text-text-secondary',
  queued: 'text-accent',
  running: 'text-status-warning',
  shipped: 'text-status-success',
  failed: 'text-status-error',
  rejected: 'text-text-tertiary',
  superseded: 'text-text-tertiary',
}

const CURATABLE_STATUSES = new Set(['proposed', 'queued'])

function FlagBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border ${
        on
          ? 'border-accent/30 bg-accent/10 text-accent'
          : 'border-border text-text-tertiary bg-transparent'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-accent' : 'bg-text-tertiary/40'}`} />
      {label}
    </span>
  )
}

function StatCard({
  label,
  value,
  tone,
  note,
}: {
  label: string
  value: string
  tone?: string
  note?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-3">
      <div className="text-[10px] text-text-tertiary uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 tabular-nums ${tone ?? 'text-text-primary'}`}>
        {value}
      </div>
      {note && <div className="text-[10px] text-text-tertiary mt-0.5">{note}</div>}
    </div>
  )
}

type InitiativeRow = InitiativesListResponse['initiatives'][number]

const TABLE_COLUMNS: Column<InitiativeRow>[] = [
  {
    key: 'project',
    label: 'Project',
    sortable: true,
    sortValue: (r) => r.project,
    render: (r) => (
      <span className="font-medium text-text-primary text-xs" data-private>
        {r.project}
      </span>
    ),
  },
  {
    key: 'kind',
    label: 'Kind',
    render: (r) => (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-bg-tertiary text-text-secondary">
        {r.kind}
      </span>
    ),
  },
  {
    key: 'title',
    label: 'Title',
    render: (r) => (
      <span className="text-xs text-text-primary line-clamp-2" title={r.title}>
        {r.pinnedAt != null && <span className="mr-1 text-accent" aria-label="pinned">📌</span>}
        {r.title}
      </span>
    ),
    cellClass: 'max-w-xs',
  },
  {
    key: 'status',
    label: 'Status',
    sortable: true,
    sortValue: (r) => r.status,
    render: (r) => (
      <span className={`text-xs ${STATUS_TONE[r.status] ?? 'text-text-secondary'}`}>
        {r.status}
      </span>
    ),
  },
  {
    key: 'score',
    label: 'Score',
    sortable: true,
    sortValue: (r) => r.score,
    initialSortDir: 'desc',
    render: (r) => (
      <span className="tabular-nums text-xs text-text-secondary font-mono">
        {r.score > 0 ? r.score.toFixed(1) : '—'}
      </span>
    ),
    cellClass: 'text-right',
    headerClass: 'text-right',
  },
  {
    key: 'updatedAt',
    label: 'Updated',
    sortable: true,
    sortValue: (r) => r.updatedAt,
    initialSortDir: 'desc',
    render: (r) => (
      <span className="tabular-nums text-xs text-text-tertiary whitespace-nowrap">
        {fmtAgo(r.updatedAt)}
      </span>
    ),
  },
]

export function InitiativesPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [initiatives, setInitiatives] = useState<InitiativesListResponse | null>(null)
  const [projects, setProjects] = useState<ProjectsResponse | null>(null)
  const [failed, setFailed] = useState(false)

  const reload = useCallback(() => {
    fetch('/api/initiatives')
      .then((r) => (r.ok ? (r.json() as Promise<InitiativesListResponse>) : Promise.reject()))
      .then((d) => { setInitiatives(d); setFailed(false) })
      .catch(() => setFailed(true))
  }, [])

  // Apply a promote/reject action to one initiative, then refresh the list.
  const act = useCallback(async (id: number, action: InitiativeAction) => {
    try { await patchInitiative(id, action); reload() }
    catch { setFailed(true) }
  }, [reload])

  useEffect(() => {
    reload()
    const id = setInterval(reload, 30_000)

    // Projects fetched once — list doesn't change at runtime
    let cancelled = false
    fetchProjects()
      .then((d) => { if (!cancelled) setProjects(d) })
      .catch(() => { /* fail silently; preview section just won't render */ })

    return () => { cancelled = true; clearInterval(id) }
  }, [reload])

  if (failed && !initiatives) {
    return (
      <div className="p-6">
        <ErrorCallout className="text-sm" preWrap={false}>
          Failed to load initiatives.
        </ErrorCallout>
      </div>
    )
  }

  if (!initiatives) {
    return (
      <div className="p-6 space-y-4">
        <div className="skeleton h-8 w-48 rounded" />
        <div className="skeleton h-24 rounded-lg" />
        <div className="skeleton h-64 rounded-lg" />
      </div>
    )
  }

  const { flags, counts, initiatives: rows } = initiatives
  const projectNames = projects?.tasks.map((t) => t.project) ?? []

  // Pinned (operator-promoted) rows lead; the Table's column sort can still re-sort.
  const sortedRows = [...rows].sort((a, b) => (b.pinnedAt ? 1 : 0) - (a.pinnedAt ? 1 : 0))

  // Operator-steering column: 👍 promote / un-pin, 👎 reject, undo for rejected rows.
  const actionsColumn: Column<InitiativeRow> = {
    key: 'actions',
    label: '',
    render: (r) => {
      const pinned = r.pinnedAt != null
      const rejected = r.status === 'rejected'
      const curatable = CURATABLE_STATUSES.has(r.status)
      return (
        <div className="flex items-center gap-1 justify-end">
          {rejected ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-text-tertiary hover:text-text-primary"
              onClick={() => act(r.id, 'restore')}
            >
              undo
            </Button>
          ) : curatable ? (
            <>
              <button
                type="button"
                aria-label={pinned ? 'Un-pin' : 'Promote'}
                title={pinned ? 'Un-pin' : 'Promote to top'}
                className={`text-sm transition-opacity ${pinned ? 'opacity-100' : 'opacity-40 hover:opacity-100'}`}
                onClick={() => act(r.id, pinned ? 'unpromote' : 'promote')}
              >👍</button>
              <button
                type="button"
                aria-label="Reject"
                title="Reject"
                className="text-sm opacity-40 hover:opacity-100 transition-opacity"
                onClick={() => act(r.id, 'reject')}
              >👎</button>
            </>
          ) : null}
        </div>
      )
    },
    cellClass: 'text-right',
  }
  const columns = [...TABLE_COLUMNS, actionsColumn]

  return (
    <div className={embedded ? 'space-y-6' : 'p-6 space-y-6 max-w-6xl'}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            {!embedded && <h1 className="text-xl font-semibold text-text-primary">Initiatives</h1>}
            <p className="text-sm text-text-secondary mt-0.5">
              What the autonomous engine has discovered and is driving through the pipeline.
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <FlagBadge label="Engine on" on={flags.engineEnabled} />
            <FlagBadge label="Mining on" on={flags.miningEnabled} />
          </div>
        </div>

        {!flags.engineEnabled && (
          <p className="text-xs text-text-tertiary">
            Engine is off — you can still preview what the Miner would find below. Enable in{' '}
            <Link href="/settings" className="text-accent hover:underline transition-colors">
              Settings
            </Link>
            .
          </p>
        )}
      </div>

      {/* ── Counts row ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <StatCard
          label="Proposed"
          value={String(counts.proposed)}
          tone={counts.proposed > 0 ? 'text-text-primary' : undefined}
        />
        <StatCard
          label="Queued"
          value={String(counts.queued)}
          tone={counts.queued > 0 ? 'text-accent' : undefined}
        />
        <StatCard
          label="Running"
          value={String(counts.running)}
          tone={counts.running > 0 ? 'text-status-warning' : undefined}
        />
        <StatCard
          label="Shipped"
          value={String(counts.shipped)}
          tone={counts.shipped > 0 ? 'text-status-success' : undefined}
          note={`max ${flags.maxShipsPerDay}/day`}
        />
        <StatCard
          label="Failed"
          value={String(counts.failed)}
          tone={counts.failed > 0 ? 'text-status-error' : undefined}
        />
      </div>

      {/* ── Preview section ─────────────────────────────────────── */}
      <section className="border border-border rounded-lg bg-bg-primary overflow-hidden">
        <div className="px-4 py-3 bg-bg-secondary border-b border-border">
          <h2 className="text-sm font-medium text-text-primary">Preview — what the Miner would find now</h2>
          <p className="text-xs text-text-tertiary mt-0.5">
            Runs probes live against each project. No writes. May take a few seconds.
          </p>
        </div>
        <div className="p-4 space-y-2">
          {projectNames.length === 0 ? (
            <p className="text-xs text-text-tertiary">No projects found.</p>
          ) : (
            projectNames.map((name) => (
              <ProjectPreviewRow key={name} projectName={name} />
            ))
          )}
        </div>
      </section>

      {/* ── Backlog table ───────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-primary">Backlog</h2>
        <Table<InitiativeRow>
          columns={columns}
          rows={sortedRows}
          getRowKey={(r) => String(r.id)}
          defaultSortKey="updatedAt"
          defaultSortDir="desc"
          emptyState={
            <EmptyState
              paddingY="sm"
              title="Nothing in the backlog yet — the engine is off or nothing mined."
            />
          }
        />
      </section>
    </div>
  )
}
