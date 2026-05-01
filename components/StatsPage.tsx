'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import type { UsageResponse, ProjectUsageRow, AgentUsageRow } from '@/app/api/stats/usage/route'
import { ErrorState } from './ErrorState'

type Window = '24h' | '7d' | '30d' | 'all'
const WINDOW_LABELS: Record<Window, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', all: 'All time' }
type SortKey = 'project' | 'runs' | 'totalTokens' | 'costUsd' | 'lastRunAt'

function fmtTokens(n: number): string {
  if (n === 0) return '0'
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`
  if (n < 10_000) return `$${n.toFixed(0)}`
  return `$${(n / 1000).toFixed(1)}K`
}

function fmtAgo(epochSec: number | null): string {
  if (!epochSec) return '—'
  const ms = Date.now() - epochSec * 1000
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return (
    <div className="h-1.5 w-full bg-bg-tertiary rounded overflow-hidden">
      <div
        className="h-full bg-accent transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function StatCard({ label, value, sub, noPrivate }: { label: string; value: string; sub?: string; noPrivate?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4">
      <div className="text-xs text-text-tertiary uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold text-text-primary mt-1 tabular-nums" {...(!noPrivate ? { 'data-private': true } : {})}>{value}</div>
      {sub && <div className="text-xs text-text-tertiary mt-1" {...(!noPrivate ? { 'data-private': true } : {})}>{sub}</div>}
    </div>
  )
}

function SortHeader({
  k, label, current, dir, onSort, align = 'left',
}: {
  k: SortKey; label: string; current: SortKey; dir: 'asc' | 'desc'
  onSort: (k: SortKey) => void; align?: 'left' | 'right'
}) {
  const active = current === k
  return (
    <th
      className={`px-3 py-2 text-xs font-medium text-text-secondary cursor-pointer select-none hover:text-text-primary transition-colors ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => onSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[10px] ${active ? 'text-accent' : 'text-text-tertiary opacity-30'}`}>
          {active ? (dir === 'desc' ? '▼' : '▲') : '↕'}
        </span>
      </span>
    </th>
  )
}

export function StatsPage() {
  const [data, setData] = useState<UsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [window_, setWindow] = useState<Window>('30d')
  const [sortKey, setSortKey] = useState<SortKey>('costUsd')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const load = useCallback(async (w: Window) => {
    try {
      const res = await fetch(`/api/stats/usage?window=${w}`)
      if (!res.ok) throw new Error('fetch failed')
      setData(await res.json())
      setError(null)
    } catch {
      setError('Failed to load usage stats')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    load(window_)
    const id = setInterval(() => load(window_), 60_000)
    return () => clearInterval(id)
  }, [load, window_])

  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    else { setSortKey(k); setSortDir(k === 'project' ? 'asc' : 'desc') }
  }

  const sorted = useMemo(() => {
    if (!data) return []
    const rows = [...data.projects]
    rows.sort((a, b) => {
      const av = a[sortKey] as number | string | null
      const bv = b[sortKey] as number | string | null
      let cmp = 0
      if (typeof av === 'string' && typeof bv === 'string') cmp = av.localeCompare(bv)
      else cmp = ((av as number | null) ?? 0) - ((bv as number | null) ?? 0)
      return sortDir === 'desc' ? -cmp : cmp
    })
    return rows
  }, [data, sortKey, sortDir])

  const maxCost = useMemo(
    () => sorted.reduce((m, r) => Math.max(m, r.costUsd), 0),
    [sorted]
  )

  if (loading && !data) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="skeleton h-11 w-full rounded-lg" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-20 rounded-lg" />)}
        </div>
        <div className="skeleton h-64 rounded-lg" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="max-w-6xl mx-auto">
        <ErrorState
          message={error ?? 'No usage data available.'}
          hint="Token usage data is collected from each Claude run's result event."
          onRetry={() => { setLoading(true); load(window_) }}
        />
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Statistics</h1>
          <p className="text-xs text-text-tertiary mt-0.5">
            Token usage and estimated cost per project · pricing assumes Sonnet rates
            (in {fmtUsd(data.pricing.input)}/M · out {fmtUsd(data.pricing.output)}/M ·
            cache write {fmtUsd(data.pricing.cacheWrite)}/M · read {fmtUsd(data.pricing.cacheRead)}/M)
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded border border-border overflow-hidden">
            {(['24h', '7d', '30d', 'all'] as Window[]).map((w) => (
              <button
                key={w}
                className={`text-xs px-2.5 py-1 border-none cursor-pointer font-medium transition-colors ${
                  window_ === w
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:text-text-primary bg-bg-secondary hover:bg-bg-tertiary'
                }`}
                onClick={() => { setWindow(w); setLoading(true) }}
              >
                {w}
              </button>
            ))}
          </div>
          <span className="text-xs text-text-tertiary">
            {loading ? 'Refreshing…' : `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
          </span>
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Total cost"
          value={fmtUsd(data.totals.costUsd)}
          sub={`${WINDOW_LABELS[window_]}`}
        />
        <StatCard
          label="Total tokens"
          value={fmtTokens(data.totals.totalTokens)}
          sub={`${fmtTokens(data.totals.inputTokens)} in / ${fmtTokens(data.totals.outputTokens)} out`}
          noPrivate
        />
        <StatCard
          label="Cache reads"
          value={fmtTokens(data.totals.cacheReadTokens)}
          sub={`saved ~${fmtUsd((data.totals.cacheReadTokens * (data.pricing.input - data.pricing.cacheRead)) / 1_000_000)}`}
          noPrivate
        />
        <StatCard
          label="Runs"
          value={data.totals.runs.toLocaleString()}
          sub={`across ${data.projects.length} project${data.projects.length === 1 ? '' : 's'}`}
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-bg-tertiary border-b border-border">
              <tr>
                <SortHeader k="project" label="Project" current={sortKey} dir={sortDir} onSort={onSort} />
                <SortHeader k="runs" label="Runs" current={sortKey} dir={sortDir} onSort={onSort} align="right" />
                <SortHeader k="totalTokens" label="Tokens" current={sortKey} dir={sortDir} onSort={onSort} align="right" />
                <th className="px-3 py-2 text-xs font-medium text-text-secondary text-right">In / Out</th>
                <th className="px-3 py-2 text-xs font-medium text-text-secondary text-right">Cache R / W</th>
                <SortHeader k="costUsd" label="Cost" current={sortKey} dir={sortDir} onSort={onSort} align="right" />
                <th className="px-3 py-2 text-xs font-medium text-text-secondary w-32">Share</th>
                <SortHeader k="lastRunAt" label="Last run" current={sortKey} dir={sortDir} onSort={onSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-text-tertiary text-sm">
                    No usage data in the last {WINDOW_LABELS[window_].toLowerCase()}.
                  </td>
                </tr>
              )}
              {sorted.map((r: ProjectUsageRow) => {
                const privateAttr = r.project === 'tamtam' ? {} : { 'data-private': true };
                return (
                  <tr
                    key={r.project}
                    className="border-b border-border/40 last:border-b-0 hover:bg-bg-tertiary/40 transition-colors"
                  >
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/project/${encodeURIComponent(r.project)}`}
                        className="font-medium text-text-primary hover:text-accent no-underline"
                        {...privateAttr}
                      >
                        {r.project}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary" {...privateAttr}>{r.runs.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-text-primary" {...privateAttr}>
                      {fmtTokens(r.totalTokens)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-xs text-text-tertiary" {...privateAttr}>
                      {fmtTokens(r.inputTokens)} / {fmtTokens(r.outputTokens)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-xs text-text-tertiary" {...privateAttr}>
                      {fmtTokens(r.cacheReadTokens)} / {fmtTokens(r.cacheCreateTokens)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-accent" {...privateAttr}>
                      {fmtUsd(r.costUsd)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Bar value={r.costUsd} max={maxCost} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs text-text-tertiary tabular-nums">
                      {fmtAgo(r.lastRunAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {sorted.length > 0 && (
              <tfoot className="bg-bg-tertiary border-t border-border">
                <tr>
                  <td className="px-3 py-2.5 text-xs font-medium text-text-secondary uppercase tracking-wide">Total</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-text-primary font-medium" data-private>{data.totals.runs.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-text-primary font-medium" data-private>{fmtTokens(data.totals.totalTokens)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-xs text-text-tertiary" data-private>
                    {fmtTokens(data.totals.inputTokens)} / {fmtTokens(data.totals.outputTokens)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-xs text-text-tertiary" data-private>
                    {fmtTokens(data.totals.cacheReadTokens)} / {fmtTokens(data.totals.cacheCreateTokens)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-accent" data-private>
                    {fmtUsd(data.totals.costUsd)}
                  </td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Top agents by kind */}
      {data.agents.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-bg-tertiary">
            <h2 className="text-sm font-medium text-text-primary">Top agents / pipeline steps</h2>
            <p className="text-xs text-text-tertiary mt-0.5">Cost breakdown by run kind — shows which step burns the most</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="border-b border-border">
                <tr>
                  <th className="px-3 py-2 text-xs font-medium text-text-secondary text-left">Kind</th>
                  <th className="px-3 py-2 text-xs font-medium text-text-secondary text-right">Runs</th>
                  <th className="px-3 py-2 text-xs font-medium text-text-secondary text-right">Tokens</th>
                  <th className="px-3 py-2 text-xs font-medium text-text-secondary text-right" title="Average prompt size sent to Claude per run (estimated tokens; actual cache size may be larger for non-agent kinds)">Avg prompt</th>
                  <th className="px-3 py-2 text-xs font-medium text-text-secondary text-right">Cost</th>
                  <th className="px-3 py-2 text-xs font-medium text-text-secondary w-32">Share</th>
                </tr>
              </thead>
              <tbody>
                {data.agents.slice(0, 5).map((r: AgentUsageRow) => (
                  <tr key={r.kind} className="border-b border-border/40 last:border-b-0 hover:bg-bg-tertiary/40 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-text-primary">{r.kind}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{r.runs.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{fmtTokens(r.totalTokens)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text-tertiary" title={r.avgPromptBytes != null ? `${r.avgPromptBytes.toLocaleString()} bytes over ${r.promptSamples} run${r.promptSamples === 1 ? '' : 's'}` : 'no prompt-size samples'}>
                      {r.avgPromptTokens != null ? `~${fmtTokens(r.avgPromptTokens)}` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-accent">{fmtUsd(r.costUsd)}</td>
                    <td className="px-3 py-2.5">
                      <Bar value={r.costUsd} max={data.agents[0]?.costUsd ?? 1} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-text-tertiary">
        Costs are estimates based on a single rate card and do not account for per-model variation.
        Token counts come from each Claude run's <code className="px-1 py-0.5 rounded bg-bg-tertiary text-text-secondary">result</code> event.
      </p>
    </div>
  )
}
