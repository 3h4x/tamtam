'use client'

import { useEffect, useState } from 'react'
import { fmtAbsolute } from '@/lib/shared/format-date'
import {
  BUDGET_SUBSCRIPTION_PROVIDERS,
  type BudgetSubscriptionProvider,
} from '@/lib/usage/subscription-providers'
import { loadQuotaSnapshot } from '@/lib/client/quota'
import { Pill } from '@/components/ui/Pill'

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

interface QuotaCardState {
  provider: BudgetSubscriptionProvider
  snapshot: QuotaSnapshot | null
  error: string | null
  isPrimary: boolean
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

function fmtPaceRatio(ratio: number): string {
  if (ratio < 0.01) return 'idle'
  if (ratio >= 10) return `${ratio.toFixed(0)}× pace`
  return `${ratio.toFixed(2)}× pace`
}

function PaceBadge({ pace }: { pace: Pace | null }) {
  if (!pace) return null
  if (pace.status === 'on-track') {
    // "on pace" hides whether the user is barely using the window or close to
    // tipping over. Always show the projected end-% so the badge carries
    // genuine information. Differentiate "under pace" (<0.85×) from "on pace".
    const isUnder = pace.ratio < 0.85
    const projected = pace.projectedEndPct.toFixed(0)
    return (
      <Pill
        tone="success"
        size="xs"
        className="rounded px-1.5 text-[10px]"
        title={`${fmtPaceRatio(pace.ratio)} · projects ${projected}% by reset`}
      >
        {isUnder ? 'under pace' : 'on pace'} · projects {projected}%
      </Pill>
    )
  }
  if (pace.status === 'over') {
    return (
      <Pill
        tone="warning"
        size="xs"
        className="rounded px-1.5 text-[10px]"
        title={`${fmtPaceRatio(pace.ratio)} · projects ${pace.projectedEndPct.toFixed(0)}% by reset`}
      >
        over pace · projects {pace.projectedEndPct.toFixed(0)}%
      </Pill>
    )
  }
  return (
    <Pill
      tone="error"
      size="xs"
      className="rounded px-1.5 text-[10px] font-semibold"
      title={`${fmtPaceRatio(pace.ratio)} · projects ${pace.projectedEndPct.toFixed(0)}% by reset`}
    >
      will exceed quota · projects {pace.projectedEndPct.toFixed(0)}%
    </Pill>
  )
}

/**
 * Project when the under-pace gap closes (or when ahead-of-pace slack runs
 * out), given the *current* burn rate vs the steady-state rate the window
 * expects. Returns a short human-readable line, or `null` when there's
 * nothing useful to say.
 *
 * Math: util grows at `elapsedRate × (burn/steady)` pp/h; elapsed grows at
 * `elapsedRate` pp/h. So gap closure rate is `elapsedRate × (burn/steady − 1)`.
 * The sign of (burn − steady) tells us whether we're catching up at all.
 */
function paceEtaText(
  win: QuotaWindow,
  pace: Pace | null,
  windowMs: number | undefined,
  burnRate: number | null,
  steadyRate: number | null,
): string | null {
  if (!pace || !windowMs || win.msUntilReset == null) return null
  if (burnRate == null || steadyRate == null) return null
  if (!Number.isFinite(burnRate) || !Number.isFinite(steadyRate)) return null
  if (steadyRate <= 0) return null
  const elapsedPct = pace.elapsedFraction * 100
  const utilPct = win.utilization
  const remainingHours = win.msUntilReset / (60 * 60 * 1000)
  if (remainingHours <= 0) return null
  // Only the dimensionless current/steady ratio matters here, so burn and
  // steady can be in any consistent unit (utilization pp/h, in practice).
  const ratio = burnRate / steadyRate
  const elapsedRatePp = 100 / (windowMs / (60 * 60 * 1000))
  if (elapsedRatePp <= 0) return null
  const gapPp = elapsedPct - utilPct // positive = under pace; negative = ahead
  if (Math.abs(gapPp) < 0.5 && Math.abs(ratio - 1) < 0.05) return 'balanced'
  if (gapPp > 0) {
    // Under pace. Catching up requires ratio > 1.
    if (ratio > 1.01) {
      const etaHours = gapPp / (elapsedRatePp * (ratio - 1))
      if (etaHours > remainingHours) {
        const needed = (gapPp / remainingHours + elapsedRatePp) / elapsedRatePp
        return `won't catch up before reset (need ${needed.toFixed(1)}× current burn)`
      }
      return `balanced in ${fmtCountdown(etaHours * 60 * 60 * 1000)}`
    }
    const gapGrowth = elapsedRatePp * (1 - ratio)
    return `falling ${gapGrowth.toFixed(2)}pp/h further behind`
  }
  // Ahead of pace. Slack closes when ratio < 1.
  if (ratio < 0.99) {
    const etaHours = -gapPp / (elapsedRatePp * (1 - ratio))
    return `slack closes in ${fmtCountdown(etaHours * 60 * 60 * 1000)}`
  }
  return null
}

function QuotaBar({
  label,
  win,
  warnAt,
  blockAt,
  windowMs,
  burnRate,
  steadyRate,
}: {
  label: string
  win: QuotaWindow
  warnAt: number
  blockAt: number
  windowMs?: number
  burnRate?: number | null
  steadyRate?: number | null
}) {
  const pct = Math.max(0, Math.min(100, win.utilization))
  const fillPct = pct === 0 ? 0 : Math.max(2, pct)
  const pace = windowMs ? computePace(win, windowMs) : null
  const expectedMarkerPct = pace ? pace.elapsedFraction * 100 : null
  const etaText = paceEtaText(
    win,
    pace,
    windowMs,
    burnRate ?? null,
    steadyRate ?? null,
  )
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
      {etaText && (
        <div
          className="text-[10px] text-text-tertiary tabular-nums"
          title="Projection from observed burn rate vs steady-state rate. Positive ETA = will close the gap at this burn; otherwise we either fall further behind or burn slack."
        >
          {etaText}
        </div>
      )}
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
  providers = [...BUDGET_SUBSCRIPTION_PROVIDERS],
  warnAt = 80,
  blockAt = 95,
  refreshSeconds = 300,
  compact = false,
}: {
  providers?: BudgetSubscriptionProvider[]
  warnAt?: number
  blockAt?: number
  refreshSeconds?: number
  /** Compact mode for /stats: no scheduled-agents row, no daily-burn row, no per-model split. */
  compact?: boolean
}) {
  const [cards, setCards] = useState<QuotaCardState[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Map of `${provider}|${windowKey}` → recent burn + steady-state rates
  // (utilization pp/h) pulled from `/api/stats/usage-history`. Used by each
  // `QuotaBar` to derive an ETA-to-balance line. Sourced from the persisted
  // quota utilization series so it's present for every provider, not just the
  // one currently burning tokens in TamTam.
  const [rates, setRates] = useState<Map<string, { burn: number | null; steady: number | null }>>(new Map())
  const providerKey = providers.join(',')

  useEffect(() => {
    let cancelled = false
    const selectedProviders = Array.from(new Set(providers))

    async function loadRates() {
      try {
        const res = await fetch('/api/stats/usage-history?hours=4')
        if (!res.ok) return
        const json = await res.json() as {
          series?: Array<{
            provider: string
            windowKey: string
            currentUtilizationPpPerHour: number | null
            steadyUtilizationPpPerHour: number | null
          }>
        }
        if (cancelled) return
        // Pace is derived from the persisted quota *utilization* series (pp/h),
        // not token throughput — so the trend renders for every provider with
        // utilization history, including ones not currently running jobs here.
        const next = new Map<string, { burn: number | null; steady: number | null }>()
        for (const s of json.series ?? []) {
          next.set(`${s.provider}|${s.windowKey}`, {
            burn: s.currentUtilizationPpPerHour,
            steady: s.steadyUtilizationPpPerHour,
          })
        }
        setRates(next)
      } catch {
        // ETA is supplementary; ignore fetch failure.
      }
    }

    async function load() {
      try {
        const [activeResult, providerResults] = await Promise.all([
          loadQuotaSnapshot('active'),
          Promise.all(selectedProviders.map((provider) => loadQuotaSnapshot(provider))),
        ])
        void loadRates()
        const activeProvider = activeResult.snapshot?.provider
        const mergedCards = selectedProviders.map((provider, index) => {
          if (activeProvider === provider && activeResult.snapshot) {
            return {
              provider,
              snapshot: activeResult.snapshot,
              error: null,
              isPrimary: false,
            }
          }
          const result = providerResults[index]
          return {
            provider,
            snapshot: result.snapshot,
            error: result.error,
            isPrimary: false,
          }
        })
        const primaryProvider =
          (activeProvider && mergedCards.find((card) => card.provider === activeProvider && card.snapshot)?.provider)
          ?? mergedCards.find((card) => card.snapshot)?.provider
          ?? null
        const nextCards = mergedCards
          .map((card) => ({
            ...card,
            isPrimary: card.provider === primaryProvider,
          }))
          .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
        if (!cancelled) {
          setCards(nextCards)
          setError(
            nextCards.some((card) => card.snapshot)
              ? null
              : activeResult.error ?? nextCards[0]?.error ?? 'Quota unavailable'
          )
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
  }, [providerKey, refreshSeconds])

  const visibleCards = cards.filter((card) => card.snapshot)

  if (loading && visibleCards.length === 0) {
    return <div className="skeleton h-24 rounded-lg" />
  }
  if (error || visibleCards.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary p-4">
        <div className="text-xs uppercase tracking-wide text-text-tertiary">Agent subscription quota</div>
        <div className="text-sm text-status-error mt-1">{error ?? 'Quota unavailable'}</div>
      </div>
    )
  }

  const renderCard = (snapshot: QuotaSnapshot, options: { primary?: boolean } = {}) => (
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
      <QuotaBar
        label="5-hour rolling"
        win={snapshot.fiveHour}
        warnAt={warnAt}
        blockAt={blockAt}
        windowMs={FIVE_HOUR_MS}
        burnRate={rates.get(`${snapshot.provider}|5h`)?.burn ?? null}
        steadyRate={rates.get(`${snapshot.provider}|5h`)?.steady ?? null}
      />
      <QuotaBar
        label="7-day weekly"
        win={snapshot.sevenDay}
        warnAt={warnAt}
        blockAt={blockAt}
        windowMs={SEVEN_DAY_MS}
        burnRate={rates.get(`${snapshot.provider}|7d`)?.burn ?? null}
        steadyRate={rates.get(`${snapshot.provider}|7d`)?.steady ?? null}
      />
      <ExtraCreditsRow extra={snapshot.extra} provider={snapshot.provider} />
      {!compact && options.primary && <DailyBurnRow sevenDay={snapshot.sevenDay} />}
      {!compact && options.primary && snapshot.gateEnabled && <ScheduledAgentsRow sevenDay={snapshot.sevenDay} />}
      {!compact && options.primary && (snapshot.sevenDaySonnet || snapshot.sevenDayOpus) && (
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
    <div className={compact ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'space-y-3'}>
      {cards.map((card) => {
        if (!card.snapshot) {
          return (
            <div key={card.provider} className="rounded-lg border border-border bg-bg-secondary p-4 space-y-2">
              <div className="text-xs uppercase tracking-wide text-text-tertiary">
                {card.provider === 'codex' ? 'Codex subscription quota' : 'Claude subscription quota'}
              </div>
              <div className="text-sm text-status-error">{card.error ?? 'Quota unavailable'}</div>
            </div>
          )
        }
        return <div key={card.provider}>{renderCard(card.snapshot, { primary: card.isPrimary })}</div>
      })}
    </div>
  )
}
