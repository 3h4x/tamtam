'use client'

import { useEffect, useState } from 'react'
import { fmtAbsolute } from '@/lib/shared/format-date'

interface QuotaWindow {
  utilization: number
  resetsAt: string | null
  msUntilReset: number | null
}

interface QuotaSnapshot {
  provider?: 'claude' | 'codex'
  planType?: string | null
  fiveHour: QuotaWindow
  sevenDay: QuotaWindow
  sevenDaySonnet?: QuotaWindow | null
  sevenDayOpus?: QuotaWindow | null
  extra?: {
    isEnabled: boolean
    monthlyLimit: number | null
    usedCredits: number | null
    utilization: number | null
    currency: string | null
  }
  fetchedAt: number
  stale: boolean
  gateEnabled?: boolean
}

interface QuotaState {
  active: QuotaSnapshot | null
  codex: QuotaSnapshot | null
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

function fmtCountdown(ms: number | null): string {
  if (ms == null) return '—'
  if (ms <= 0) return 'soon'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function barClass(pct: number, warnAt: number, blockAt: number): string {
  if (pct >= blockAt) return 'bg-status-error'
  if (pct >= warnAt) return 'bg-status-warning'
  return 'bg-accent'
}

interface Pace {
  /** Fraction of the window that has elapsed, 0..1 */
  elapsedFraction: number
  /** elapsed % vs current utilization, where 1.0 means dead-on pace */
  ratio: number
  /** Linear projection of end-of-window utilization */
  projectedEndPct: number
  /** Status badge */
  status: 'on-track' | 'over' | 'blown'
}

function computePace(win: QuotaWindow, windowMs: number): Pace | null {
  if (win.msUntilReset == null) return null
  const elapsed = Math.max(0, windowMs - win.msUntilReset)
  const elapsedFraction = Math.min(1, elapsed / windowMs)
  // Window just reset — no signal yet, treat as on-track.
  if (elapsedFraction < 0.005) {
    return { elapsedFraction, ratio: 0, projectedEndPct: win.utilization, status: 'on-track' }
  }
  const expectedPct = elapsedFraction * 100
  const ratio = win.utilization / expectedPct
  const projectedEndPct = win.utilization / elapsedFraction
  const status: Pace['status'] = projectedEndPct >= 100 ? 'blown' : ratio >= 1.15 ? 'over' : 'on-track'
  return { elapsedFraction, ratio, projectedEndPct, status }
}

function PaceBadge({ pace }: { pace: Pace | null }) {
  if (!pace) return null
  if (pace.status === 'on-track') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-success/15 text-status-success font-medium">
        on pace
      </span>
    )
  }
  if (pace.status === 'over') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-warning/15 text-status-warning font-medium">
        {pace.ratio.toFixed(1)}× pace · projects {pace.projectedEndPct.toFixed(0)}%
      </span>
    )
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-error/15 text-status-error font-semibold">
      will exceed quota · projects {pace.projectedEndPct.toFixed(0)}%
    </span>
  )
}

function QuotaBar({
  label,
  win,
  warnAt,
  blockAt,
  windowMs,
}: {
  label: string
  win: QuotaWindow
  warnAt: number
  blockAt: number
  windowMs?: number
}) {
  const pct = Math.max(0, Math.min(100, win.utilization))
  const fillPct = pct === 0 ? 0 : Math.max(2, pct)
  const pace = windowMs ? computePace(win, windowMs) : null
  const expectedMarkerPct = pace ? pace.elapsedFraction * 100 : null
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs flex-wrap">
        <span className="font-medium text-text-secondary flex items-center gap-2">
          {label}
          <PaceBadge pace={pace} />
        </span>
        <span className="tabular-nums text-text-tertiary">
          <span className="text-text-primary font-semibold">{pct.toFixed(0)}%</span>
          {' · resets in '}
          {fmtCountdown(win.msUntilReset)}
        </span>
      </div>
      <div className="relative h-2 w-full bg-bg-tertiary rounded overflow-hidden">
        <div
          className={`h-full transition-all duration-500 ${barClass(pct, warnAt, blockAt)}`}
          style={{ width: `${fillPct}%` }}
        />
        {expectedMarkerPct != null && expectedMarkerPct > 0 && expectedMarkerPct < 100 && (
          <div
            className="absolute top-0 h-full w-px bg-text-primary/60"
            style={{ left: `${expectedMarkerPct}%` }}
            title={`Fair-share pace marker: ${expectedMarkerPct.toFixed(0)}% elapsed`}
          />
        )}
      </div>
    </div>
  )
}

function ScheduledAgentsRow({ sevenDay }: { sevenDay: QuotaWindow }) {
  if (sevenDay.msUntilReset == null) return null
  const elapsedMs = Math.max(0, SEVEN_DAY_MS - sevenDay.msUntilReset)
  if (elapsedMs <= 0) return null
  const projectedEndPct = sevenDay.utilization * (SEVEN_DAY_MS / elapsedMs)
  if (projectedEndPct <= 100) {
    return (
      <div className="flex items-baseline justify-between gap-2 text-xs px-3 py-2 rounded bg-bg-tertiary/50">
        <span className="font-medium text-text-secondary">Scheduled agents</span>
        <span className="tabular-nums">
          <span className="font-semibold text-status-success">firing</span>
          <span className="text-text-tertiary"> · 7d projection {projectedEndPct.toFixed(0)}%</span>
        </span>
      </div>
    )
  }
  // Blocked. Resume when utilization × (windowMs/elapsedMs) ≤ 100, assuming
  // flat usage from now (manual work pushes it later). Compute the absolute
  // wall-clock time so the user knows when cron resumes without doing math.
  const requiredElapsedMs = sevenDay.utilization * SEVEN_DAY_MS / 100
  const msUntilResume = Math.max(0, requiredElapsedMs - elapsedMs)
  const resumeAtMs = Date.now() + msUntilResume
  // Cap at the window reset — past that the new window starts at 0% and they fire anyway.
  const resetMs = sevenDay.resetsAt ? new Date(sevenDay.resetsAt).getTime() : null
  const effectiveResumeMs = resetMs && resumeAtMs > resetMs ? resetMs : resumeAtMs
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs px-3 py-2 rounded bg-status-error/10 border border-status-error/20">
      <span className="font-medium text-status-error">Scheduled agents</span>
      <span className="tabular-nums text-right">
        <span className="font-semibold text-status-error">paused</span>
        <span className="text-text-secondary">
          {' · resumes '}
          <span className="font-medium text-text-primary">{fmtAbsolute(effectiveResumeMs)}</span>
          <span className="text-text-tertiary"> (in {fmtCountdown(msUntilResume)})</span>
        </span>
      </span>
    </div>
  )
}

function DailyBurnRow({ sevenDay }: { sevenDay: QuotaWindow }) {
  if (sevenDay.msUntilReset == null) return null
  const elapsedMs = Math.max(0, SEVEN_DAY_MS - sevenDay.msUntilReset)
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000)
  if (elapsedDays < 0.05) return null
  const dailyAvg = sevenDay.utilization / elapsedDays
  const dailyTarget = 100 / 7 // 14.29%
  const ratio = dailyAvg / dailyTarget
  const status: 'on-track' | 'over' | 'blown' =
    dailyAvg * 7 >= 100 ? 'blown' : ratio >= 1.15 ? 'over' : 'on-track'
  const tone =
    status === 'blown'
      ? 'text-status-error'
      : status === 'over'
        ? 'text-status-warning'
        : 'text-status-success'
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs px-3 py-2 rounded bg-bg-tertiary/50">
      <span className="font-medium text-text-secondary">Daily burn</span>
      <span className="tabular-nums">
        <span className={`font-semibold ${tone}`}>{dailyAvg.toFixed(1)}%/day</span>
        <span className="text-text-tertiary">
          {' · target '}
          {dailyTarget.toFixed(1)}%/day
          {' · '}
          {ratio.toFixed(1)}×
        </span>
      </span>
    </div>
  )
}

function ExtraCreditsRow({
  extra,
  provider,
}: {
  extra: QuotaSnapshot['extra']
  provider?: QuotaSnapshot['provider']
}) {
  if (!extra?.isEnabled || typeof extra.utilization !== 'number') return null
  const exhausted = extra.utilization >= 100
  const tone = exhausted ? 'text-status-error' : extra.utilization >= 80 ? 'text-status-warning' : 'text-status-success'
  const isCodex = provider === 'codex'
  const title = isCodex ? 'Model credit gate' : 'Extra usage'
  const label = exhausted ? (isCodex ? 'blocked' : 'exhausted') : `${extra.utilization.toFixed(0)}% used`
  const resetText = isCodex ? 'no reset reported' : 'no reset timestamp'
  return (
    <div className={`flex items-baseline justify-between gap-2 text-xs px-3 py-2 rounded ${exhausted ? 'bg-status-error/10 border border-status-error/20' : 'bg-bg-tertiary/50'}`}>
      <span className={`font-medium ${exhausted ? 'text-status-error' : 'text-text-secondary'}`}>{title}</span>
      <span className="tabular-nums">
        <span className={`font-semibold ${tone}`}>{label}</span>
        <span className="text-text-tertiary"> · {resetText}</span>
      </span>
    </div>
  )
}

export function QuotaWidget({
  warnAt = 80,
  blockAt = 95,
  refreshSeconds = 60,
  compact = false,
}: {
  warnAt?: number
  blockAt?: number
  refreshSeconds?: number
  /** Compact mode for /stats: no scheduled-agents row, no daily-burn row, no per-model split. */
  compact?: boolean
}) {
  const [data, setData] = useState<QuotaState>({ active: null, codex: null })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [activeRes, codexRes] = await Promise.all([
          fetch('/api/usage/quota'),
          fetch('/api/usage/quota?provider=codex'),
        ])
        if (!activeRes.ok) throw new Error((await activeRes.json())?.error ?? `HTTP ${activeRes.status}`)
        const active = (await activeRes.json()) as QuotaSnapshot
        const codex = codexRes.ok ? ((await codexRes.json()) as QuotaSnapshot) : null
        if (!cancelled) {
          setData({ active, codex: active.provider === 'codex' ? null : codex })
          setError(null)
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, refreshSeconds * 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [refreshSeconds])

  if (loading && !data.active) {
    return <div className="skeleton h-24 rounded-lg" />
  }
  if (error || !data.active) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary p-4">
        <div className="text-xs uppercase tracking-wide text-text-tertiary">Agent subscription quota</div>
        <div className="text-sm text-status-error mt-1">{error ?? 'Quota unavailable'}</div>
      </div>
    )
  }

  const renderCard = (snapshot: QuotaSnapshot, options: { secondary?: boolean } = {}) => (
    <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-text-tertiary">
            {snapshot.provider === 'codex' ? 'Codex subscription quota' : 'Claude subscription quota'}
          </div>
          <div className="text-[10px] text-text-tertiary mt-0.5">
            {snapshot.stale ? 'stale (last successful fetch)' : `updated ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`}
          </div>
        </div>
        <div className="text-[10px] text-text-tertiary">
          warn ≥ {warnAt}% · block ≥ {blockAt}%
        </div>
      </div>
      <QuotaBar label="5-hour rolling" win={snapshot.fiveHour} warnAt={warnAt} blockAt={blockAt} windowMs={FIVE_HOUR_MS} />
      <QuotaBar label="7-day weekly" win={snapshot.sevenDay} warnAt={warnAt} blockAt={blockAt} windowMs={SEVEN_DAY_MS} />
      <ExtraCreditsRow extra={snapshot.extra} provider={snapshot.provider} />
      {!compact && !options.secondary && <DailyBurnRow sevenDay={snapshot.sevenDay} />}
      {!compact && !options.secondary && snapshot.gateEnabled && <ScheduledAgentsRow sevenDay={snapshot.sevenDay} />}
      {!compact && !options.secondary && (snapshot.sevenDaySonnet || snapshot.sevenDayOpus) && (
        <div className="grid grid-cols-2 gap-3 pt-1">
          {snapshot.sevenDaySonnet && (
            <QuotaBar label="7d · Sonnet" win={snapshot.sevenDaySonnet} warnAt={warnAt} blockAt={blockAt} windowMs={SEVEN_DAY_MS} />
          )}
          {snapshot.sevenDayOpus && (
            <QuotaBar label="7d · Opus" win={snapshot.sevenDayOpus} warnAt={warnAt} blockAt={blockAt} windowMs={SEVEN_DAY_MS} />
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-3">
      {renderCard(data.active)}
      {data.codex && renderCard(data.codex, { secondary: true })}
    </div>
  )
}
