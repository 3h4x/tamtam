'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { BridgeResponse, BridgeProject, BridgeProjectStatus } from '@/app/api/stats/bridge/route'
import type { GlobalPace, WindowPace, PaceStatus } from '@/lib/usage/quota-pace'

// "The Bridge" — a compact command-center strip at the top of /stats. One card,
// three dense rows: pace headroom, per-provider pace chips, and a per-project
// shipping status line. Generic: it renders whatever projects the API reports
// as having enabled agents.

function fmtAgo(epochSec: number | null): string {
  if (!epochSec) return '—'
  const m = Math.floor((Date.now() - epochSec * 1000) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function fmtMargin(n: number | null): string {
  if (n == null) return '—'
  const r = Math.round(n)
  return r >= 0 ? `+${r}` : `${r}`
}

const STATUS_META: Record<BridgeProjectStatus, { dot: string; tone: string; label: string }> = {
  shipping: { dot: 'bg-status-success', tone: 'text-status-success', label: 'shipping' },
  active: { dot: 'bg-accent', tone: 'text-accent', label: 'active' },
  releasing: { dot: 'bg-status-warning animate-pulse', tone: 'text-status-warning', label: 'releasing' },
  attention: { dot: 'bg-status-error', tone: 'text-status-error', label: 'needs attention' },
  paused: { dot: 'bg-status-error', tone: 'text-status-error', label: 'paused' },
  idle: { dot: 'bg-text-tertiary/50', tone: 'text-text-tertiary', label: 'idle' },
}

const PACE_TONE: Record<PaceStatus, string> = {
  under_pace: 'text-status-success',
  on_pace: 'text-status-warning',
  will_exceed: 'text-status-warning',
  exceeded: 'text-status-error',
  unknown: 'text-text-tertiary',
}

function paceHeadline(g: GlobalPace): { text: string; tone: string } {
  const tone = PACE_TONE[g.status] ?? 'text-text-tertiary'
  if (g.status === 'unknown' || g.marginPct == null) {
    return { text: 'pace —', tone }
  }
  const where = g.bindingProvider ? ` · ${g.bindingProvider} ${g.bindingWindow ?? ''}`.trimEnd() : ''
  if (g.status === 'exceeded') return { text: `over quota${where}`, tone }
  if (g.status === 'will_exceed') {
    return { text: `will exceed → ${g.projectedPct ?? '?'}%${where}`, tone }
  }
  if (g.status === 'on_pace') return { text: `${fmtMargin(g.marginPct)} vs pace${where}`, tone }
  return { text: `${fmtMargin(g.marginPct)} to pace${where}`, tone }
}

function tightestWindow(p: { fiveHour: WindowPace | null; sevenDay: WindowPace | null }): WindowPace | null {
  const both = [p.fiveHour, p.sevenDay].filter(Boolean) as WindowPace[]
  if (both.length === 0) return null
  return both.reduce((a, b) => (a.paceMarginPct <= b.paceMarginPct ? a : b))
}

function ProviderChip({ provider, fiveHour, sevenDay }: GlobalPace['providers'][number]) {
  const tight = tightestWindow({ fiveHour, sevenDay })
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded bg-bg-tertiary/60 whitespace-nowrap">
      <span className="font-medium text-text-secondary">{provider}</span>
      {sevenDay && (
        <span className="tabular-nums text-text-tertiary">
          7d <span className="text-text-primary">{Math.round(sevenDay.utilizationPct)}%</span>{' '}
          <span className={PACE_TONE[sevenDay.status]}>{fmtMargin(sevenDay.paceMarginPct)}</span>
        </span>
      )}
      {fiveHour && (
        <span className="tabular-nums text-text-tertiary">
          5h <span className="text-text-primary">{Math.round(fiveHour.utilizationPct)}%</span>{' '}
          <span className={PACE_TONE[fiveHour.status]}>{fmtMargin(fiveHour.paceMarginPct)}</span>
        </span>
      )}
      {!tight && <span className="text-text-tertiary">no data</span>}
    </span>
  )
}

function ProjectChip({ p }: { p: BridgeProject }) {
  const meta = STATUS_META[p.status]
  const at = p.status === 'active' ? p.lastAgentAt : (p.lastPushAt ?? p.lastAgentAt)
  const title =
    `${p.project} · ${meta.label} · ${p.agents} agent${p.agents === 1 ? '' : 's'}` +
    (p.lastPushAt ? ` · pushed ${fmtAgo(p.lastPushAt)} ago${p.lastPushOk === false ? ' (failed)' : ''}` : '') +
    (p.lastReleaseOk === false ? ' · last release failed' : '')
  return (
    <Link
      href={`/project/${encodeURIComponent(p.project)}`}
      title={title}
      className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border border-border/60 bg-bg-secondary hover:bg-bg-tertiary/60 no-underline whitespace-nowrap transition-colors"
      data-private
    >
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${meta.dot}`} />
      <span className="font-medium text-text-primary">{p.project}</span>
      <span className={`${meta.tone}`}>{fmtAgo(at)}</span>
    </Link>
  )
}

export function BridgeOverview() {
  const [data, setData] = useState<BridgeResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch('/api/stats/bridge')
        .then((r) => (r.ok ? (r.json() as Promise<BridgeResponse>) : Promise.reject()))
        .then((d) => { if (!cancelled) { setData(d); setFailed(false) } })
        .catch(() => { if (!cancelled) setFailed(true) })
    load()
    const id = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (failed && !data) return null // supplementary — never block the page
  if (!data) return <div className="skeleton h-20 rounded-lg" />

  const pace = paceHeadline(data.globalPace)
  const s = data.summary

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-3 space-y-2.5">
      {/* Row 1 — title + global pace + throttle */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wide">Bridge</span>
        <span className="text-[10px] text-text-tertiary">fleet pace · shipping status</span>
        <span className={`ml-auto text-xs font-medium tabular-nums ${pace.tone}`}>{pace.text}</span>
        {data.throttle && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-error/15 text-status-error font-semibold whitespace-nowrap">
            scheduler throttled · {data.throttle.worstProvider} {Math.round(data.throttle.projectedPct)}%
          </span>
        )}
      </div>

      {/* Row 2 — per-provider pace chips */}
      {data.globalPace.providers.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {data.globalPace.providers.map((p) => (
            <ProviderChip key={p.provider} {...p} />
          ))}
        </div>
      )}

      {/* Row 3 — project shipping chips */}
      {data.projects.length > 0 ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          {data.projects.map((p) => (
            <ProjectChip key={p.project} p={p} />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-text-tertiary">No projects with enabled agents.</div>
      )}

      {/* Row 4 — one-line summary */}
      <div className="text-[10px] text-text-tertiary tabular-nums">
        {s.projects} project{s.projects === 1 ? '' : 's'} · {s.agentsEnabled} agent{s.agentsEnabled === 1 ? '' : 's'}
        {s.shipping > 0 && <> · <span className="text-status-success">{s.shipping} shipping</span></>}
        {s.releasing > 0 && <> · <span className="text-status-warning">{s.releasing} releasing</span></>}
        {s.attention > 0 && <> · <span className="text-status-error">{s.attention} attention</span></>}
        {s.paused > 0 && <> · <span className="text-status-error">{s.paused} paused</span></>}
        {s.idle > 0 && <> · {s.idle} idle</>}
      </div>
    </div>
  )
}
