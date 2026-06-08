'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { InlineLoading } from '@/components/ui/InlineLoading'

interface UsageHistoryBucket {
  bucketTs: number
  provider: string
  windowKey: string
  totalTokens: number | null
  catchUpTokensPerHour: number | null
}

interface ProviderSeries {
  provider: string
  windowKey: string
  buckets: UsageHistoryBucket[]
  currentTokensPerHour: number | null
  expectedTokensPerHour: number | null
  catchUpTokensPerHour: number | null
}

interface UsageHistoryResponse {
  generatedAt: number
  hours: number
  series: ProviderSeries[]
}

function fmtTokens(n: number | null | undefined): string {
  // No data → display 0 (e.g. provider with no jobs in a bucket). The em-dash
  // placeholder is misleading because "no jobs" genuinely means "0 tokens".
  if (n === null || n === undefined || !Number.isFinite(n)) return '0'
  if (n === 0) return '0'
  if (n < 1_000) return n.toFixed(0)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

function fmtHour(bucketTs: number): string {
  const d = new Date(bucketTs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

type ChartPoint = {
  bucketTs: number
  hour: string
  actual: number | null
  catchUp: number | null
}

function ProviderChart({
  label,
  series,
}: {
  label: string
  series: ProviderSeries
}) {
  const data: ChartPoint[] = useMemo(
    () =>
      series.buckets.map((b) => ({
        bucketTs: b.bucketTs,
        hour: fmtHour(b.bucketTs),
        actual: b.totalTokens,
        catchUp: b.catchUpTokensPerHour,
      })),
    [series.buckets],
  )
  const hasAnyTokens = data.some((p) => p.actual !== null && p.actual > 0)
  const hasAnyRate =
    series.currentTokensPerHour !== null
    || series.expectedTokensPerHour !== null
    || series.catchUpTokensPerHour !== null

  // Where will we actually land at window reset? actual_rate / steady_rate × 100.
  // This is the single most useful summary number: it's the projected end-of-
  // window utilization %, expressed at the *current* burn rate. If actual is
  // half of steady, you'll land at 50%; if equal, you'll land at 100%.
  const projectionPct = (() => {
    const a = series.currentTokensPerHour
    const s = series.expectedTokensPerHour
    if (a == null || s == null || !Number.isFinite(a) || !Number.isFinite(s) || s <= 0) return null
    return Math.round((a / s) * 100)
  })()
  const projectionTone =
    projectionPct == null
      ? 'text-text-tertiary'
      : projectionPct >= 100
        ? 'text-status-error'
        : projectionPct >= 85
          ? 'text-status-warning'
          : 'text-status-success'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-text-primary flex items-center gap-2">
          {label}
          {projectionPct != null && (
            <span
              className={`tabular-nums font-semibold ${projectionTone}`}
              title="At the current burn rate, this is where utilization will land by window reset. Under 100% = under pace; over 100% = will exceed quota."
            >
              → projects {projectionPct}%
            </span>
          )}
        </span>
        <span className="flex gap-3 text-text-tertiary">
          <span title="Tokens/h burned this hour — sum of input + output + cache reads + cache creates, averaged over last 3 buckets. Same accounting as the quota uses."><span className="inline-block w-3 h-0.5 bg-status-info align-middle mr-1" />actual {fmtTokens(series.currentTokensPerHour)}/h</span>
          <span title="Steady-state rate that uses exactly 100% of the window evenly, derived from observed tokens vs utilization."><span className="inline-block w-3 h-0.5 bg-status-success align-middle mr-1 border-dashed" />steady pace {fmtTokens(series.expectedTokensPerHour)}/h</span>
          <span title="The rate you'd need to sustain from now until window reset to STILL land at 100%. Rising = NOT catching up (every quiet hour shrinks the remaining time, so required burn climbs). Falling toward steady pace = actually catching up. Capped at 5× steady pace for readability — the raw value diverges in the last minutes of a window with leftover quota."><span className="inline-block w-3 h-0.5 bg-status-warning align-middle mr-1 border-dashed" />to-100% rate {fmtTokens(series.catchUpTokensPerHour)}/h</span>
        </span>
      </div>
      {!hasAnyTokens && !hasAnyRate ? (
        <EmptyState
          title="No jobs routed to this provider in this window."
          description="Agents currently run elsewhere; this chart will populate once a job completes here."
          paddingY="xs"
          className="h-40 rounded bg-bg-secondary"
        />
      ) : (
      <div className="w-full h-40 bg-bg-secondary rounded">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} />
            <XAxis
              dataKey="bucketTs"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tick={{ fill: 'currentColor', fontSize: 10, opacity: 0.6 }}
              tickLine={false}
              axisLine={{ stroke: 'currentColor', strokeOpacity: 0.15 }}
              minTickGap={32}
              tickFormatter={(v) => fmtHour(v as number)}
            />
            <YAxis
              tick={{ fill: 'currentColor', fontSize: 10, opacity: 0.6 }}
              tickLine={false}
              axisLine={{ stroke: 'currentColor', strokeOpacity: 0.15 }}
              tickFormatter={(v) => fmtTokens(v as number)}
              width={48}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--color-bg-primary, #fff)',
                border: '1px solid var(--color-border, #e5e7eb)',
                borderRadius: 6,
                fontSize: 12,
              }}
              labelStyle={{ color: 'var(--color-text-secondary, #555)' }}
              formatter={(value, name) => [fmtTokens(Number(value)), String(name)]}
              labelFormatter={(label, payload) => {
                const p = payload?.[0]?.payload as ChartPoint | undefined
                if (!p) return label
                return new Date(p.bucketTs).toLocaleString()
              }}
            />
            <Line
              type="monotone"
              dataKey="actual"
              name="actual"
              stroke="var(--color-status-info, #3b82f6)"
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            {series.expectedTokensPerHour !== null && (
              <ReferenceLine
                y={series.expectedTokensPerHour}
                stroke="var(--color-status-success, #10b981)"
                strokeDasharray="4 3"
                ifOverflow="extendDomain"
              />
            )}
            <Line
              type="monotone"
              dataKey="catchUp"
              name="to-100% rate"
              stroke="var(--color-status-warning, #f59e0b)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      )}
    </div>
  )
}

export function UsageHistoryChart({ hours = 24 }: { hours?: number } = {}) {
  const [data, setData] = useState<UsageHistoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  // Single-chart view: tab selector. Default shows the aggregate; clicking a
  // provider chip switches the view to that provider's chart.
  const [selected, setSelected] = useState<string>('avg')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`/api/stats/usage-history?hours=${hours}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as UsageHistoryResponse
        if (!cancelled) {
          setData(json)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [hours, reloadNonce])

  if (error) {
    return (
      <ErrorState
        message={`usage-history: ${error}`}
        onRetry={() => {
          setError(null)
          setReloadNonce((n) => n + 1)
        }}
      />
    )
  }
  if (!data) {
    return <InlineLoading label="Loading usage history…" />
  }

  const sevenDay = data.series.filter((s) => s.windowKey === '7d')
  if (sevenDay.length === 0) {
    return (
      <EmptyState
        title="No history yet"
        description="First snapshot lands within ~5 min of boot."
        paddingY="xs"
        align="start"
        className="!px-0 !py-0"
      />
    )
  }

  // Build aggregate: union of all bucket timestamps; per-bucket avg totalTokens across providers.
  const allTs = new Set<number>()
  for (const s of sevenDay) for (const b of s.buckets) allTs.add(b.bucketTs)
  const sortedTs = Array.from(allTs).sort((a, b) => a - b)
  const bucketsByProvider = sevenDay.map((s) => new Map(s.buckets.map((b) => [b.bucketTs, b])))
  const aggregateBuckets: UsageHistoryBucket[] = sortedTs.map((ts) => {
    const tokenVals: number[] = []
    const catchVals: number[] = []
    for (const buckets of bucketsByProvider) {
      const match = buckets.get(ts)
      if (!match) continue
      if (match.totalTokens !== null) tokenVals.push(match.totalTokens)
      if (match.catchUpTokensPerHour !== null) catchVals.push(match.catchUpTokensPerHour)
    }
    const avgVal = tokenVals.length > 0 ? tokenVals.reduce((a, b) => a + b, 0) / tokenVals.length : null
    const avgCatch = catchVals.length > 0 ? catchVals.reduce((a, b) => a + b, 0) / catchVals.length : null
    return {
      bucketTs: ts,
      provider: 'avg',
      windowKey: '7d',
      totalTokens: avgVal,
      catchUpTokensPerHour: avgCatch,
    }
  })
  const aggregate: ProviderSeries = {
    provider: 'avg',
    windowKey: '7d',
    buckets: aggregateBuckets,
    currentTokensPerHour: avg(sevenDay.map((s) => s.currentTokensPerHour)),
    expectedTokensPerHour: avg(sevenDay.map((s) => s.expectedTokensPerHour)),
    catchUpTokensPerHour: avg(sevenDay.map((s) => s.catchUpTokensPerHour)),
  }

  const tabs: Array<{ key: string; label: string; series: ProviderSeries }> = [
    { key: 'avg', label: 'all providers', series: aggregate },
    ...sevenDay.map((s) => ({ key: s.provider, label: s.provider, series: s })),
  ]
  const active = tabs.find((t) => t.key === selected) ?? tabs[0]

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        ariaLabel="Provider"
        options={tabs.map((t) => ({ value: t.key, label: t.label }))}
        value={active.key}
        onChange={setSelected}
        className="self-start"
      />

      <ProviderChart
        label={active.key === 'avg' ? 'all providers · average' : `${active.series.provider} · 7d window`}
        series={active.series}
      />
    </div>
  )
}

function avg(values: Array<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (xs.length === 0) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
