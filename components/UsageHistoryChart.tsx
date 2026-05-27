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
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
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

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-text-primary">{label}</span>
        <span className="flex gap-3 text-text-tertiary">
          <span title="Tokens/h burned this hour (average of last 3 buckets)"><span className="inline-block w-3 h-0.5 bg-status-info align-middle mr-1" />actual {fmtTokens(series.currentTokensPerHour)}/h</span>
          <span title="Steady-state rate that uses exactly 100% of the window evenly"><span className="inline-block w-3 h-0.5 bg-status-success align-middle mr-1 border-dashed" />steady pace {fmtTokens(series.expectedTokensPerHour)}/h</span>
          <span title="Max rate you can sustain until window reset and still land at 100%"><span className="inline-block w-3 h-0.5 bg-status-warning align-middle mr-1 border-dashed" />catch-up ceiling {fmtTokens(series.catchUpTokensPerHour)}/h</span>
        </span>
      </div>
      {!hasAnyTokens && !hasAnyRate ? (
        <div className="w-full h-40 bg-bg-secondary rounded flex items-center justify-center text-xs text-text-tertiary px-4 text-center">
          No jobs routed to this provider in the last 48h. Agents currently run elsewhere; this chart will populate once a job completes here.
        </div>
      ) : (
      <div className="w-full h-40 bg-bg-secondary rounded">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} />
            <XAxis
              dataKey="hour"
              tick={{ fill: 'currentColor', fontSize: 10, opacity: 0.6 }}
              tickLine={false}
              axisLine={{ stroke: 'currentColor', strokeOpacity: 0.15 }}
              minTickGap={32}
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
              name="catch-up ceiling"
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

export function UsageHistoryChart() {
  const [data, setData] = useState<UsageHistoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Single-chart view: tab selector. Default shows the aggregate; clicking a
  // provider chip switches the view to that provider's chart.
  const [selected, setSelected] = useState<string>('avg')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/stats/usage-history?hours=48')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as UsageHistoryResponse
        if (!cancelled) setData(json)
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
  }, [])

  if (error) return <div className="text-sm text-status-error">usage-history: {error}</div>
  if (!data) return <div className="text-sm text-text-tertiary">Loading usage history…</div>

  const sevenDay = data.series.filter((s) => s.windowKey === '7d')
  if (sevenDay.length === 0) {
    return <div className="text-sm text-text-tertiary">No history yet — first snapshot lands within ~5 min of boot.</div>
  }

  // Build aggregate: union of all bucket timestamps; per-bucket avg totalTokens across providers.
  const allTs = new Set<number>()
  for (const s of sevenDay) for (const b of s.buckets) allTs.add(b.bucketTs)
  const sortedTs = Array.from(allTs).sort((a, b) => a - b)
  const aggregateBuckets: UsageHistoryBucket[] = sortedTs.map((ts) => {
    const tokenVals: number[] = []
    const catchVals: number[] = []
    for (const s of sevenDay) {
      const match = s.buckets.find((b) => b.bucketTs === ts)
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
      <div className="flex flex-wrap gap-1">
        {tabs.map((t) => {
          const isActive = t.key === active.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setSelected(t.key)}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                isActive
                  ? 'border-status-info text-status-info bg-bg-primary'
                  : 'border-border text-text-tertiary bg-bg-secondary hover:bg-bg-hover'
              }`}
            >
              {t.label}
            </button>
          )
        })}
      </div>
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
