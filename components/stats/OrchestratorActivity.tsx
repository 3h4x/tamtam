'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { OrchestratorStatsResponse } from '@/app/api/stats/orchestrator/route'

// epoch-seconds → "Xm ago" / "Xh ago" / "Xd ago"
function fmtAgo(epochSec: number): string {
  if (!epochSec) return '—'
  const m = Math.floor((Date.now() - epochSec * 1_000) / 60_000)
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

const ACTION_TYPE_LABEL: Record<string, string> = {
  orchestrator_boost: 'boost',
  agent_autopilot: 'autopilot',
  orchestrator_agent_health: 'health',
}

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

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-3">
      <div className="text-[10px] text-text-tertiary uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 tabular-nums ${tone ?? 'text-text-primary'}`}>{value}</div>
    </div>
  )
}

export function OrchestratorActivity() {
  const [data, setData] = useState<OrchestratorStatsResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch('/api/stats/orchestrator')
        .then((r) => (r.ok ? (r.json() as Promise<OrchestratorStatsResponse>) : Promise.reject()))
        .then((d) => { if (!cancelled) { setData(d); setFailed(false) } })
        .catch(() => { if (!cancelled) setFailed(true) })
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (failed && !data) return null
  if (!data) return <div className="skeleton h-24 rounded-lg" />

  const { flags, initiatives, actions } = data
  const counts = initiatives.counts

  return (
    <section className="border border-border rounded-lg p-4 bg-bg-primary space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-medium text-text-primary">Orchestrator</h2>
        <Link href="/initiatives" className="text-[11px] text-text-tertiary hover:text-accent transition-colors ml-1">
          View backlog →
        </Link>
        <div className="flex items-center gap-1.5 flex-wrap">
          <FlagBadge label="Tuning" on={flags.orchestratorEnabled} />
          <FlagBadge label="Engine" on={flags.initiativeEngineEnabled} />
          <FlagBadge label="Mining" on={flags.initiativeMiningEnabled} />
        </div>
        {!flags.initiativeEngineEnabled && (
          <span className="ml-auto text-[11px] text-text-tertiary">
            Initiative engine is off — enable in Settings
          </span>
        )}
      </div>

      {/* Initiative counts grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <MiniStat label="Queued" value={String(counts.queued)} tone={counts.queued > 0 ? 'text-accent' : undefined} />
        <MiniStat label="Running" value={String(counts.running)} tone={counts.running > 0 ? 'text-status-warning' : undefined} />
        <MiniStat
          label="Shipped today"
          value={`${initiatives.shippedToday} / ${flags.maxShipsPerDay}`}
          tone={initiatives.shippedToday > 0 ? 'text-status-success' : undefined}
        />
        <MiniStat label="Failed" value={String(counts.failed)} tone={counts.failed > 0 ? 'text-status-error' : undefined} />
      </div>

      {/* 24h action counts */}
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="Boosts (24h)" value={String(actions.last24h.boosts)} />
        <MiniStat label="Autopilot (24h)" value={String(actions.last24h.autopilot)} />
        <MiniStat label="Health concerns (24h)" value={String(actions.last24h.healthConcerns)} tone={actions.last24h.healthConcerns > 0 ? 'text-status-warning' : undefined} />
      </div>

      {/* Recent initiatives + recent actions side-by-side on large screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent initiatives */}
        <div>
          <div className="text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-2">
            Recent initiatives
          </div>
          {initiatives.recent.length === 0 ? (
            <p className="text-[11px] text-text-tertiary">No recent initiatives.</p>
          ) : (
            <div className="space-y-0.5">
              {initiatives.recent.slice(0, 8).map((row, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-[11px] py-1 border-b border-border/40 last:border-0"
                >
                  <span className="font-medium text-text-primary truncate max-w-[80px]" data-private>{row.project}</span>
                  <span className="text-text-tertiary font-mono truncate flex-1">{row.kind}</span>
                  <span className={`shrink-0 ${STATUS_TONE[row.status] ?? 'text-text-secondary'}`}>{row.status}</span>
                  <span className="tabular-nums text-text-tertiary shrink-0">
                    {row.score > 0 ? `${row.score.toFixed(1)}` : '—'}
                  </span>
                  <span className="tabular-nums text-text-tertiary shrink-0">
                    {fmtAgo(Math.floor(row.updatedAt / 1_000))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent orchestrator actions */}
        <div>
          <div className="text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-2">
            Recent actions
          </div>
          {actions.recent.length === 0 ? (
            <p className="text-[11px] text-text-tertiary">No recent orchestrator actions.</p>
          ) : (
            <div className="space-y-0.5">
              {actions.recent.slice(0, 8).map((row, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-[11px] py-1 border-b border-border/40 last:border-0"
                >
                  <span className="shrink-0 font-mono text-[10px] text-text-tertiary bg-bg-tertiary rounded px-1 py-px">
                    {ACTION_TYPE_LABEL[row.type] ?? row.type}
                  </span>
                  <span className="font-medium text-text-primary truncate max-w-[80px]" data-private>{row.project}</span>
                  <span className="text-text-secondary truncate flex-1" title={row.title}>{row.title}</span>
                  <span className="tabular-nums text-text-tertiary shrink-0">{fmtAgo(row.updatedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
