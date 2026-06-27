'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import type { UsageResponse, ProjectUsageRow, AgentUsageRow, SkillUsageRow } from '@/app/api/stats/usage/route'
import type { OllamaStatsResponse } from '@/app/api/stats/ollama/route'
import { ErrorState } from './ErrorState'
import { OllamaUsageCard } from './OllamaUsageCard'
import { QuotaWidget } from './QuotaWidget'
import { BridgeOverview } from './BridgeOverview'
import { OrchestratorActivity } from './stats/OrchestratorActivity'
import { UsageHistoryChart } from './UsageHistoryChart'
import { buttonVariants } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Table, type Column } from '@/components/ui/Table'
import {
  normalizeBudgetSubscriptionProviders,
  type BudgetSubscriptionProvider,
} from '@/lib/usage/subscription-providers'

type Window = '24h' | '7d' | '30d' | 'all'
const WINDOW_LABELS: Record<Window, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', all: 'All time' }
const WINDOW_OPTIONS: Array<{ value: Window; label: string }> = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'all' },
]
// usage-history is bounded to 14d server-side, so 30d / all collapse to the max.
const WINDOW_HOURS: Record<Window, number> = { '24h': 24, '7d': 168, '30d': 336, all: 336 }

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

export function StatsPage() {
  const [data, setData] = useState<UsageResponse | null>(null)
  const [ollama, setOllama] = useState<OllamaStatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [window_, setWindow] = useState<Window>('24h')
  const [warnAt, setWarnAt] = useState(80)
  const [blockAt, setBlockAt] = useState(95)
  const [budgetProviders, setBudgetProviders] = useState<BudgetSubscriptionProvider[]>(
    normalizeBudgetSubscriptionProviders(null)
  )

  const load = useCallback(async (w: Window) => {
    // Fetch in parallel because the two endpoints are independent; each
    // refresh pays max(usage, ollama) latency instead of serial latency.
    // Ollama panel is supplementary, so its failure must never block
    // the primary usage panel from rendering.
    const [usageResult, ollamaResult] = await Promise.allSettled([
      fetch(`/api/stats/usage?window=${w}`).then((res) => {
        if (!res.ok) throw new Error('fetch failed');
        return res.json() as Promise<UsageResponse>;
      }),
      fetch(`/api/stats/ollama?window=${w}`).then((res) =>
        res.ok ? (res.json() as Promise<OllamaStatsResponse>) : null,
      ),
    ]);

    if (usageResult.status === 'fulfilled') {
      setData(usageResult.value);
      setError(null);
    } else {
      setError('Failed to load usage stats');
    }
    setLoading(false);

    setOllama(ollamaResult.status === 'fulfilled' ? ollamaResult.value : null);
  }, [])

  useEffect(() => {
    setLoading(true)
    load(window_)
    const id = setInterval(() => load(window_), 60_000)
    return () => clearInterval(id)
  }, [load, window_])

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.ok ? r.json() : null)
      .then((payload: { settings?: Record<string, string> } | null) => {
        const s = payload?.settings
        if (!s) return
        const w = parseInt(s.budget_warn_at_pct, 10)
        const b = parseInt(s.budget_block_at_pct, 10)
        if (!isNaN(w)) setWarnAt(w)
        if (!isNaN(b)) setBlockAt(b)
        setBudgetProviders(normalizeBudgetSubscriptionProviders(s.budget_subscription_providers))
      })
      .catch(() => { /* keep defaults on error */ })
  }, [])

  const projectRows = data?.projects ?? []
  const maxCost = useMemo(
    () => projectRows.reduce((m, r) => Math.max(m, r.costUsd), 0),
    [projectRows]
  )

  // Mask everything except this app's own row from screenshots/redaction.
  const priv = (project: string) => (project === 'tamtam' ? {} : { 'data-private': true as const })

  const projectColumns: Column<ProjectUsageRow>[] = [
    {
      key: 'project',
      label: 'Project',
      sortable: true,
      sortValue: (r) => r.project,
      initialSortDir: 'asc',
      render: (r) => (
        <Link
          href={`/project/${encodeURIComponent(r.project)}`}
          className={buttonVariants({ variant: 'link', className: 'font-medium text-text-primary no-underline hover:text-accent' })}
          {...priv(r.project)}
        >
          {r.project}
        </Link>
      ),
    },
    {
      key: 'runs',
      label: 'Runs',
      sortable: true,
      sortValue: (r) => r.runs,
      initialSortDir: 'desc',
      headerClass: 'text-right',
      cellClass: 'text-right tabular-nums text-text-secondary',
      render: (r) => <span {...priv(r.project)}>{r.runs.toLocaleString()}</span>,
    },
    {
      key: 'totalTokens',
      label: 'Tokens',
      sortable: true,
      sortValue: (r) => r.totalTokens,
      initialSortDir: 'desc',
      headerClass: 'text-right',
      cellClass: 'text-right tabular-nums font-medium text-text-primary',
      render: (r) => <span {...priv(r.project)}>{fmtTokens(r.totalTokens)}</span>,
    },
    {
      key: 'inout',
      label: 'In / Out',
      headerClass: 'text-right',
      cellClass: 'text-right tabular-nums text-xs text-text-tertiary',
      render: (r) => (
        <span {...priv(r.project)}>
          {fmtTokens(r.inputTokens)} / {fmtTokens(r.outputTokens)}
        </span>
      ),
    },
    {
      key: 'cache',
      label: 'Cache R / W',
      headerClass: 'text-right',
      cellClass: 'text-right tabular-nums text-xs text-text-tertiary',
      render: (r) => (
        <span {...priv(r.project)}>
          {fmtTokens(r.cacheReadTokens)} / {fmtTokens(r.cacheCreateTokens)}
        </span>
      ),
    },
    {
      key: 'costUsd',
      label: 'Cost',
      sortable: true,
      sortValue: (r) => r.costUsd,
      initialSortDir: 'desc',
      headerClass: 'text-right',
      cellClass: 'text-right tabular-nums font-semibold text-accent',
      render: (r) => <span {...priv(r.project)}>{fmtUsd(r.costUsd)}</span>,
    },
    {
      key: 'share',
      label: 'Share',
      headerClass: 'w-32',
      render: (r) => <Bar value={r.costUsd} max={maxCost} />,
    },
    {
      key: 'lastRunAt',
      label: 'Last run',
      sortable: true,
      sortValue: (r) => r.lastRunAt ?? 0,
      initialSortDir: 'desc',
      headerClass: 'text-right',
      cellClass: 'text-right text-xs text-text-tertiary tabular-nums',
      render: (r) => fmtAgo(r.lastRunAt),
    },
  ]

  if (loading && !data) {
    return (
      <div className="w-full space-y-6">
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
      <div className="w-full">
        <ErrorState
          message={error ?? 'No usage data available.'}
          hint="Token usage data is collected from each Claude run's result event."
          onRetry={() => { setLoading(true); load(window_) }}
        />
      </div>
    )
  }

  const topAgents = data.agents.slice(0, 5)
  const topAgentMaxCost = data.agents[0]?.costUsd ?? 1
  const skillRows = data.skills ?? []

  return (
    <div className="w-full space-y-5">
      {/* Header bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold text-text-primary">Statistics</h1>
            <span className="text-xs text-text-tertiary">· token usage & estimated cost</span>
          </div>
          <p className="text-xs text-text-tertiary mt-0.5">
            Pricing assumes Sonnet rates: input {fmtUsd(data.pricing.input)}/M · output {fmtUsd(data.pricing.output)}/M ·
            cache write {fmtUsd(data.pricing.cacheWrite)}/M · cache read {fmtUsd(data.pricing.cacheRead)}/M
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            options={WINDOW_OPTIONS}
            value={window_}
            ariaLabel="Stats time window"
            onChange={(w) => { setWindow(w); setLoading(true) }}
          />
          <span className="text-xs text-text-tertiary tabular-nums">
            {loading ? 'Refreshing…' : `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
          </span>
        </div>
      </div>

      {/* Bridge — fleet command center, top-of-page */}
      <BridgeOverview />

      {/* Orchestrator — initiative engine activity */}
      <OrchestratorActivity />

      {/* Totals */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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

      {/* Burn chart + quota row — chart on left, quota stacked on right */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <section className="border border-border rounded-lg p-4 bg-bg-primary xl:col-span-3">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h2 className="text-sm font-medium text-text-primary">Tokens / hour ({WINDOW_LABELS[window_]})</h2>
            <span className="text-[11px] text-text-tertiary">actual · steady pace · to-100% rate</span>
          </div>
          <UsageHistoryChart hours={WINDOW_HOURS[window_]} />
        </section>
        <div className="xl:col-span-2">
          <QuotaWidget providers={budgetProviders} warnAt={warnAt} blockAt={blockAt} compact />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        <Table<ProjectUsageRow>
          bordered={false}
          className="rounded-none"
          defaultSortKey="costUsd"
          defaultSortDir="desc"
          columns={projectColumns}
          rows={projectRows}
          getRowKey={(r) => r.project}
          rowClassName={() => 'hover:bg-bg-tertiary/40'}
          emptyState={(
            <EmptyState
              paddingY="md"
              title={(
                <span className="font-normal text-text-tertiary">
                  No usage data in the last {WINDOW_LABELS[window_].toLowerCase()}.
                </span>
              )}
            />
          )}
          footer={projectRows.length > 0 ? (
            <tr className="bg-bg-tertiary border-t border-border">
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
          ) : undefined}
        />
      </div>

      {/* Top agents by kind */}
      {topAgents.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-bg-tertiary">
            <h2 className="text-sm font-medium text-text-primary">Top agents / pipeline steps</h2>
            <p className="text-xs text-text-tertiary mt-0.5">Cost breakdown by run kind — shows which step burns the most</p>
          </div>
          <Table<AgentUsageRow>
            className="rounded-none border-0"
            columns={[
              {
                key: 'kind',
                label: 'Kind',
                render: (r) => <span className="font-mono text-text-primary">{r.kind}</span>,
              },
              {
                key: 'runs',
                label: 'Runs',
                headerClass: 'text-right',
                cellClass: 'text-right tabular-nums text-text-secondary',
                render: (r) => (
                  <>
                    {r.runs.toLocaleString()}
                    {r.kind === 'commit' && r.commitProducingRuns > 0 && (
                      <span className="block text-xs text-text-tertiary">
                        {r.commitProducingRuns.toLocaleString()} committed
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: 'tokens',
                label: 'Tokens',
                headerClass: 'text-right',
                cellClass: 'text-right tabular-nums text-text-secondary',
                render: (r) => fmtTokens(r.totalTokens),
              },
              {
                key: 'avg-prompt',
                label: 'Avg prompt',
                title: 'Average prompt size sent to Claude per run (estimated tokens; actual cache size may be larger for non-agent kinds)',
                headerClass: 'text-right',
                cellClass: 'text-right tabular-nums text-text-tertiary',
                cellTitle: (r) => (
                  r.avgPromptBytes != null
                    ? `${r.avgPromptBytes.toLocaleString()} bytes over ${r.promptSamples} run${r.promptSamples === 1 ? '' : 's'}`
                    : 'no prompt-size samples'
                ),
                render: (r) => (r.avgPromptTokens != null ? `~${fmtTokens(r.avgPromptTokens)}` : '—'),
              },
              {
                key: 'cost',
                label: 'Cost',
                headerClass: 'text-right',
                cellClass: 'text-right tabular-nums font-semibold text-accent',
                render: (r) => fmtUsd(r.costUsd),
              },
              {
                key: 'share',
                label: 'Share',
                headerClass: 'w-32',
                render: (r) => <Bar value={r.costUsd} max={topAgentMaxCost} />,
              },
            ]}
            rows={topAgents}
            getRowKey={(r) => r.kind}
            rowClassName={() => 'hover:bg-bg-tertiary/40'}
          />
        </div>
      )}

      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-bg-tertiary">
          <h2 className="text-sm font-medium text-text-primary">By skill</h2>
          <p className="text-xs text-text-tertiary mt-0.5">Estimated prompt and cache-read cost attributed by skill prompt length</p>
        </div>
        <Table<SkillUsageRow>
          className="rounded-none border-0"
          defaultSortKey="cost"
          defaultSortDir="desc"
          columns={[
            {
              key: 'skill',
              label: 'Skill',
              sortable: true,
              sortValue: (r) => r.skill,
              initialSortDir: 'asc',
              render: (r) => (
                <span className="font-medium text-text-primary" title={r.skillId}>
                  {r.skill}
                </span>
              ),
            },
            {
              key: 'runs',
              label: 'Runs',
              sortable: true,
              sortValue: (r) => r.runs,
              initialSortDir: 'desc',
              headerClass: 'text-right',
              cellClass: 'text-right tabular-nums text-text-secondary',
              render: (r) => r.runs.toLocaleString(),
            },
            {
              key: 'prompt',
              label: 'Est. prompt tokens',
              sortable: true,
              sortValue: (r) => r.promptTokens,
              initialSortDir: 'desc',
              headerClass: 'text-right',
              cellClass: 'text-right tabular-nums text-text-secondary',
              render: (r) => fmtTokens(r.promptTokens),
            },
            {
              key: 'cache',
              label: 'Est. cache-read tokens',
              sortable: true,
              sortValue: (r) => r.cacheReadTokens,
              initialSortDir: 'desc',
              headerClass: 'text-right',
              cellClass: 'text-right tabular-nums text-text-secondary',
              render: (r) => fmtTokens(r.cacheReadTokens),
            },
            {
              key: 'cost',
              label: 'Total spend',
              sortable: true,
              sortValue: (r) => r.costUsd,
              initialSortDir: 'desc',
              headerClass: 'text-right',
              cellClass: 'text-right tabular-nums font-semibold text-accent',
              render: (r) => fmtUsd(r.costUsd),
            },
          ]}
          rows={skillRows}
          getRowKey={(r) => r.skillId}
          rowClassName={() => 'hover:bg-bg-tertiary/40'}
          emptyState={(
            <EmptyState
              paddingY="md"
              title={(
                <span className="font-normal text-text-tertiary">
                  No skill attribution data in the last {WINDOW_LABELS[window_].toLowerCase()}.
                </span>
              )}
            />
          )}
        />
      </div>

      {ollama && <OllamaUsageCard data={ollama} windowLabel={WINDOW_LABELS[window_]} />}

      <p className="text-xs text-text-tertiary">
        Costs are estimates based on a single rate card and do not account for per-model variation.
        Token counts come from each Claude run's <code className="px-1 py-0.5 rounded bg-bg-tertiary text-text-secondary">result</code> event.
      </p>
    </div>
  )
}
