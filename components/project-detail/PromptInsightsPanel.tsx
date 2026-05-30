'use client'

import { usePromptInsights } from '@/hooks/usePromptInsights'
import { Spinner } from '@/components/ui/Spinner'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function formatPercent(rate: number, sampled: number): string {
  if (sampled === 0) return '—'
  return `${Math.round(rate * 100)}%`
}

function formatScore(n: number | null): string {
  if (n === null) return '—'
  return n.toFixed(3)
}

function topReason(reasons: Record<string, number>): string | null {
  const entries = Object.entries(reasons)
  if (entries.length === 0) return null
  entries.sort((a, b) => b[1] - a[1])
  return `${entries[0][0]} (${entries[0][1]})`
}

export function PromptInsightsPanel({ projectName }: { projectName: string }) {
  const { data, loading } = usePromptInsights(projectName, 7)

  if (loading && !data) {
    return (
      <section className="rounded-md border border-border bg-bg-secondary p-3">
        <div className="text-sm font-medium text-text-primary mb-1">Prompt insights</div>
        <div className="inline-flex items-center gap-1.5 text-xs text-text-tertiary" role="status">
          <Spinner size="sm" shrink aria-hidden="true" />
          Loading…
        </div>
      </section>
    )
  }
  if (!data || data.agentJobCount === 0) {
    return (
      <section className="rounded-md border border-border bg-bg-secondary p-3">
        <div className="text-sm font-medium text-text-primary mb-1">Prompt insights</div>
        <div className="text-xs text-text-tertiary">
          No agent runs in the last {data?.windowDays ?? 7} days yet.
        </div>
      </section>
    )
  }

  const ret = data.retrieval
  const mem = data.memory
  const reasonTop = topReason(ret.reasons)
  const promptAvg = data.promptBytes ? formatBytes(data.promptBytes.avg) : '—'
  const promptP95 = data.promptBytes ? formatBytes(data.promptBytes.p95) : '—'
  const promptMax = data.promptBytes ? formatBytes(data.promptBytes.max) : '—'

  return (
    <section className="rounded-md border border-border bg-bg-secondary p-3">
      <header className="flex items-baseline justify-between gap-2 mb-2">
        <h2 className="text-sm font-medium text-text-primary">Prompt insights</h2>
        <span className="text-[11px] text-text-tertiary tabular-nums">
          last {data.windowDays} days · {data.agentJobCount} agent runs
        </span>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
        <div className="min-w-0">
          <div className="text-text-tertiary uppercase tracking-wider text-[10px] mb-0.5">Avg prompt</div>
          <div className="font-mono tabular-nums text-text-primary">{promptAvg}</div>
          <div className="text-text-tertiary tabular-nums">p95 {promptP95} · max {promptMax}</div>
        </div>

        <div className="min-w-0">
          <div className="text-text-tertiary uppercase tracking-wider text-[10px] mb-0.5">Retrieval attached</div>
          <div className="font-mono tabular-nums text-text-primary">
            {formatPercent(ret.attachRate, ret.queried)}
          </div>
          <div className="text-text-tertiary tabular-nums">
            {ret.attached}/{ret.queried} queried{ret.sampled > ret.queried ? ` · ${ret.sampled - ret.queried} skipped` : ''}
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-text-tertiary uppercase tracking-wider text-[10px] mb-0.5">Avg top score</div>
          <div className="font-mono tabular-nums text-text-primary">{formatScore(ret.avgTopScore)}</div>
          <div className="text-text-tertiary tabular-nums">
            {ret.avgAcceptedChunks !== null ? `${ret.avgAcceptedChunks.toFixed(1)} chunks avg` : 'no attachments'}
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-text-tertiary uppercase tracking-wider text-[10px] mb-0.5">Top retrieval reason</div>
          <div className="font-mono text-text-primary truncate" title={reasonTop ?? ''}>{reasonTop ?? '—'}</div>
        </div>

        <div className="min-w-0">
          <div className="text-text-tertiary uppercase tracking-wider text-[10px] mb-0.5">Memory truncated</div>
          <div className="font-mono tabular-nums text-text-primary">
            {formatPercent(mem.truncationRate, mem.sampled)}
          </div>
          <div className="text-text-tertiary tabular-nums">
            {mem.truncatedCount}/{mem.sampled} runs · avg {mem.avgRawChars ?? 0} chars
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-text-tertiary uppercase tracking-wider text-[10px] mb-0.5">Prereq output</div>
          <div className="font-mono tabular-nums text-text-primary">
            {data.prereq.withPrereq}/{data.prereq.withPrereq + data.prereq.withoutPrereq}
          </div>
          <div className="text-text-tertiary tabular-nums">runs include prereq</div>
        </div>
      </div>
    </section>
  )
}
