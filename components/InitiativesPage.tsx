'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { InitiativesListResponse } from '@/app/api/initiatives/route'
import type { ProjectsResponse } from '@/lib/shared/types'
import { fetchProjects } from '@/lib/client/projects'
import { patchInitiative, type InitiativeAction } from '@/lib/client-api'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { ProjectPreviewRow } from '@/components/initiatives/ProjectPreviewRow'
import { ProjectBacklogGroup } from '@/components/initiatives/ProjectBacklogGroup'

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

  // Group the backlog by project. Each group sorts + caps internally
  // (ProjectBacklogGroup), and projects are ordered by their best score so the
  // most-relevant work surfaces first.
  const byProject = new Map<string, InitiativeRow[]>()
  for (const r of rows) {
    const list = byProject.get(r.project)
    if (list) list.push(r)
    else byProject.set(r.project, [r])
  }
  const groups = [...byProject.entries()].sort(
    (a, b) => Math.max(...b[1].map((r) => r.score)) - Math.max(...a[1].map((r) => r.score)),
  )

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

      {/* ── Backlog — grouped per project, top 3 each ────────────── */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-text-primary">Backlog</h2>
          <span className="text-[11px] text-text-tertiary">top 3 per project · 👍 promote · 👎 reject</span>
        </div>
        {groups.length === 0 ? (
          <EmptyState
            paddingY="sm"
            title="Nothing in the backlog yet — the engine is off or nothing mined."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {groups.map(([project, projRows]) => (
              <ProjectBacklogGroup key={project} project={project} rows={projRows} act={act} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
