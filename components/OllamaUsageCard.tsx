'use client'

import type { OllamaStatsResponse } from '@/app/api/stats/ollama/route'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table, type Column } from '@/components/ui/Table'

function fmtTokens(n: number): string {
  if (n === 0) return '0'
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function fmtAgo(epochSec: number | null): string {
  if (!epochSec) return 'never'
  const ms = Date.now() - epochSec * 1000
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function OllamaUsageCard({ data, windowLabel }: { data: OllamaStatsResponse; windowLabel: string }) {
  const { totals, models, sources, projects } = data
  const avgDuration = totals.calls > 0 ? totals.durationMs / totals.calls : 0

  return (
    <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-bg-tertiary">
        <h2 className="text-sm font-medium text-text-primary">Local embeddings (Ollama)</h2>
        <p className="text-xs text-text-tertiary mt-0.5">
          Tracks every <code className="px-1 py-0.5 rounded bg-bg-secondary text-text-secondary">/api/embed</code> call —
          retrieval indexing and prompt-time queries. Local-only, no API cost.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4">
        <Stat label="Embed calls" value={totals.calls.toLocaleString()} sub={windowLabel} />
        <Stat label="Input tokens" value={fmtTokens(totals.inputTokens)} sub="cumulative" />
        <Stat label="Compute time" value={fmtDuration(totals.durationMs)} sub={`avg ${fmtDuration(avgDuration)} / call`} />
        <Stat label="Last call" value={fmtAgo(totals.lastCallAt)} />
      </div>

      {totals.calls > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border border-t border-border">
          <Breakdown title="By model" rows={models.map((r) => ({ key: r.model, ...r }))} />
          <Breakdown title="By source" rows={sources.map((r) => ({ key: r.sourceKind, ...r }))} />
          <Breakdown title="By project" rows={projects.map((r) => ({ key: r.project, ...r }))} />
        </div>
      )}

      {totals.calls === 0 && (
        <EmptyState
          paddingY="sm"
          title={(
            <span className="font-normal text-text-tertiary">
              No Ollama activity in the last {windowLabel.toLowerCase()}.
            </span>
          )}
        />
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-xs text-text-tertiary uppercase tracking-wide">{label}</div>
      <div className="text-xl font-semibold text-text-primary mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-text-tertiary mt-0.5">{sub}</div>}
    </div>
  )
}

interface BreakdownRow {
  key: string
  calls: number
  inputTokens: number
  durationMs: number
}

function Breakdown({ title, rows }: { title: string; rows: BreakdownRow[] }) {
  const columns: Column<BreakdownRow>[] = [
    {
      key: 'key',
      label: 'key',
      render: (r) => r.key,
      cellTitle: (r) => r.key,
      cellClass: 'pr-2 text-text-primary font-mono truncate max-w-[140px]',
    },
    {
      key: 'calls',
      label: 'calls',
      render: (r) => r.calls.toLocaleString(),
      cellClass: 'px-2 text-right tabular-nums text-text-secondary',
    },
    {
      key: 'tokens',
      label: 'tokens',
      render: (r) => fmtTokens(r.inputTokens),
      cellClass: 'px-2 text-right tabular-nums text-text-tertiary',
    },
    {
      key: 'duration',
      label: 'duration',
      render: (r) => fmtDuration(r.durationMs),
      cellClass: 'pl-2 text-right tabular-nums text-text-tertiary',
    },
  ]

  return (
    <div className="bg-bg-secondary p-4">
      <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">{title}</div>
      <Table
        columns={columns}
        rows={rows.slice(0, 6)}
        getRowKey={(r) => r.key}
        showHeader={false}
        bordered={false}
        tableTextClassName="text-xs"
        cellPaddingClassName="py-1"
        rowClassName={() => 'border-border/30 hover:bg-transparent'}
        emptyState={<div className="py-1 text-text-tertiary">—</div>}
      />
    </div>
  )
}
