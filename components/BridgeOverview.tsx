'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { BridgeResponse, BridgeProject, BridgeProjectStatus } from '@/app/api/stats/bridge/route'
import type { SystemSample } from '@/lib/shared/system-metrics'
import { buttonVariants } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import type { GlobalPace, WindowPace, PaceStatus } from '@/lib/usage/quota-pace'

// "The Bridge" — a compact command-center strip at the top of /stats. One card,
// dense rows: fleet pace, host resources, per-provider pace, per-project
// shipping status. Generic: it renders whatever projects the API reports as
// having enabled agents, plus live host CPU/memory/disk from the in-process
// system-metrics sampler.

interface SystemMetricsResponse {
  current: SystemSample | null
  samples: SystemSample[]
}

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

// Three-band tone for a host metric: below `warn` is healthy, `warn`–`err` is
// caution, at/above `err` is hot. Null (no sample yet) is muted.
function metricTone(value: number | null, warn: number, err: number): string {
  if (value == null) return 'text-text-tertiary'
  if (value >= err) return 'text-status-error'
  if (value >= warn) return 'text-status-warning'
  return 'text-status-success'
}

const STATUS_META: Record<BridgeProjectStatus, { dot: string; tone: string; label: string }> = {
  shipping: { dot: 'bg-status-success', tone: 'text-status-success', label: 'shipping' },
  active: { dot: 'bg-accent', tone: 'text-accent', label: 'active' },
  agent_running: { dot: 'bg-accent animate-pulse', tone: 'text-accent', label: 'agent running' },
  releasing: { dot: 'bg-status-warning animate-pulse', tone: 'text-status-warning', label: 'releasing' },
  stuck: { dot: 'bg-status-error animate-pulse', tone: 'text-status-error', label: 'stuck' },
  error: { dot: 'bg-status-error', tone: 'text-status-error', label: 'error' },
  attention: { dot: 'bg-status-error', tone: 'text-status-error', label: 'needs attention' },
  paused: { dot: 'bg-text-tertiary', tone: 'text-text-tertiary', label: 'paused' },
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

// One labelled host metric: dim label + colour-coded value. Renders nothing
// when the value is unavailable (e.g. disk/io on a host without df/iostat).
function HostMetric({ label, value, tone, title }: { label: string; value: string | null; tone: string; title: string }) {
  if (value == null) return null
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap" title={title}>
      <span className="text-text-tertiary">{label}</span>
      <span className={`tabular-nums font-medium ${tone}`}>{value}</span>
    </span>
  )
}

// Compact host-resource strip: CPU · load-per-core · memory · disk · disk IO.
// Driven by the in-process system-metrics sampler (one sample/min). Mirrors
// external host metrics for whatever host TamTam itself runs on.
function HostMetrics({ s }: { s: SystemSample }) {
  return (
    <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] border-t border-border/60 pt-2">
      <span className="text-[10px] uppercase tracking-wider font-mono text-text-tertiary">host</span>
      <HostMetric
        label="cpu"
        value={s.cpuPct == null ? null : `${Math.round(s.cpuPct)}%`}
        tone={metricTone(s.cpuPct, 70, 90)}
        title={`Whole-host CPU utilization across ${s.cpuCount} cores`}
      />
      <HostMetric
        label="load"
        value={`${s.loadPerCore.toFixed(2)}×`}
        tone={metricTone(s.loadPerCore, 1, 1.5)}
        title={`1-min load ${s.load1.toFixed(2)} / ${s.cpuCount} cores (5m ${s.load5.toFixed(2)}, 15m ${s.load15.toFixed(2)}). Above 1× = more runnable work than cores.`}
      />
      <HostMetric
        label="mem"
        value={`${Math.round(s.memPct)}%`}
        tone={metricTone(s.memPct, 80, 92)}
        title={`${Math.round(s.memUsedMb)} / ${Math.round(s.memTotalMb)} MB used`}
      />
      <HostMetric
        label="disk"
        value={s.diskUsedPct == null ? null : `${Math.round(s.diskUsedPct)}%`}
        tone={metricTone(s.diskUsedPct, 80, 90)}
        title="Root filesystem usage"
      />
      <HostMetric
        label="io"
        value={s.diskIoMbS == null ? null : `${s.diskIoMbS.toFixed(1)}MB/s`}
        tone="text-text-secondary"
        title="Combined disk throughput"
      />
    </div>
  )
}

function ProviderChip({ provider, fiveHour, sevenDay }: GlobalPace['providers'][number]) {
  const tight = tightestWindow({ fiveHour, sevenDay })
  return (
    <Pill size="xs" className="border-transparent bg-bg-tertiary/60 text-[11px] font-normal whitespace-nowrap">
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
    </Pill>
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
      className={buttonVariants({
        variant: 'secondary',
        size: 'sm',
        className: 'text-[11px] font-normal border-border/60 hover:bg-bg-tertiary/60 whitespace-nowrap',
      })}
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
  const [system, setSystem] = useState<SystemSample | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      // Two independent endpoints. Bridge drives the card; system metrics are
      // supplementary, so a system fetch failure must not blank the card.
      const bridge = fetch('/api/stats/bridge')
        .then((r) => (r.ok ? (r.json() as Promise<BridgeResponse>) : Promise.reject()))
        .then((d) => { if (!cancelled) { setData(d); setFailed(false) } })
        .catch(() => { if (!cancelled) setFailed(true) })
      fetch('/api/stats/system')
        .then((r) => (r.ok ? (r.json() as Promise<SystemMetricsResponse>) : Promise.reject()))
        .then((d) => { if (!cancelled) setSystem(d.current) })
        .catch(() => { /* host metrics are optional */ })
      return bridge
    }
    void load()
    const id = setInterval(() => void load(), 30_000)
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
        <span className="text-[10px] text-text-tertiary">fleet pace · shipping status · host</span>
        <span className={`ml-auto text-xs font-medium tabular-nums ${pace.tone}`}>{pace.text}</span>
        {data.throttle && (
          <Pill size="xs" tone="error" className="border-transparent text-[10px] font-semibold whitespace-nowrap">
            scheduler throttled · {data.throttle.worstProvider} {Math.round(data.throttle.projectedPct)}%
          </Pill>
        )}
      </div>

      {/* Row 2 — live host resources (CPU / load / mem / disk / IO) */}
      {system && <HostMetrics s={system} />}

      {/* Row 3 — per-provider pace chips */}
      {data.globalPace.providers.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {data.globalPace.providers.map((p) => (
            <ProviderChip key={p.provider} {...p} />
          ))}
        </div>
      )}

      {/* Row 4a — "needs attention" projects, surfaced prominently so the
          eye lands on them first. Only renders when at least one project is
          stuck / errored / flagged for attention; the "all projects" strip
          below still includes them for completeness. */}
      {(() => {
        const attention = data.projects.filter(
          (p) => p.status === 'attention' || p.status === 'stuck' || p.status === 'error',
        )
        if (attention.length === 0) return null
        return (
          <div className="flex items-center gap-2 flex-wrap rounded-md border border-status-error/40 bg-status-error/[0.06] px-2 py-1.5">
            <span className="text-[10px] uppercase tracking-wider font-mono text-status-error font-semibold">
              needs attention
            </span>
            {attention.map((p) => (
              <ProjectChip key={`att-${p.project}`} p={p} />
            ))}
          </div>
        )
      })()}

      {/* Row 4b — all project shipping chips */}
      {data.projects.length > 0 ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          {data.projects.map((p) => (
            <ProjectChip key={p.project} p={p} />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-text-tertiary">No projects with enabled agents.</div>
      )}

      {/* Row 5 — one-line summary */}
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
