'use client'

import { useRouter } from 'next/navigation'
import { useSchedulerHealth } from '@/hooks/useSchedulerHealth'
import { useAgentStats, type AgentStat } from '@/hooks/useAgentStats'

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = s / 60
  if (m < 60) return `${m.toFixed(1)}m`
  return `${(m / 60).toFixed(1)}h`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatCost(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(2)}`
}

function statSummaryLine(s: AgentStat): string[] {
  const totalTokens = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreateTokens
  const parts: string[] = []
  if (s.runs > 0) parts.push(`${s.runs} run${s.runs === 1 ? '' : 's'}`)
  if (s.avgDurationMs) parts.push(`avg ${formatDuration(s.avgDurationMs)}`)
  if (s.runs > 0 && s.finishedRuns > 0) {
    const successRate = Math.round((s.successfulRuns / s.finishedRuns) * 100)
    if (successRate < 100) parts.push(`${successRate}% success`)
  }
  if (totalTokens > 0) parts.push(`${formatTokens(totalTokens)} tok`)
  if (s.costUsd > 0) parts.push(formatCost(s.costUsd))
  if (s.modifiedFilesCount > 0) parts.push(`${s.modifiedFilesCount} files touched`)
  if (s.reviewFixesTriggered > 0) parts.push(`${s.reviewFixesTriggered} fixes triggered`)
  return parts
}

function formatRelative(ms: number): string {
  const delta = ms - Date.now()
  const abs = Math.abs(delta)
  const minutes = Math.round(abs / 60_000)
  const hours = Math.round(abs / 3_600_000)
  const days = Math.round(abs / 86_400_000)
  const future = delta > 0
  if (minutes < 1) return future ? 'in <1m' : 'just now'
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`
  return future ? `in ${days}d` : `${days}d ago`
}

export function AgentsStats({ projectName }: { projectName: string }) {
  const router = useRouter()
  const { entries, loading } = useSchedulerHealth(projectName)
  const { byName: statsByName } = useAgentStats(projectName)

  if (loading) {
    return (
      <section className="mb-4 rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
        <div className="skeleton h-4 w-24 rounded mb-2" />
        <div className="skeleton h-4 w-64 rounded" />
      </section>
    )
  }

  const goToAgents = (agentId?: string) => {
    const base = `/project/${projectName}/agents`
    router.push(agentId ? `${base}?agent=${encodeURIComponent(agentId)}` : base)
  }

  if (entries.length === 0) {
    return (
      <section className="mb-4 rounded-lg border border-border bg-bg-secondary px-3 py-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text-primary">No scheduled agents</div>
          <div className="text-xs text-text-tertiary mt-0.5">Add an agent to automate work for this project.</div>
        </div>
        <button
          type="button"
          className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
          onClick={() => goToAgents()}
        >
          Open Agents tab
        </button>
      </section>
    )
  }

  // Earliest next fire across enabled entries
  const enabledEntries = entries.filter(e => e.enabled && e.nextFireMs > 0)
  const next = enabledEntries.length > 0
    ? enabledEntries.reduce((best, e) => (e.nextFireMs < best.nextFireMs ? e : best))
    : null

  // Project-wide aggregates from stats so users see total impact at a glance.
  let totalCost = 0
  let totalTokens = 0
  let totalFiles = 0
  let totalRuns = 0
  for (const s of statsByName.values()) {
    totalCost += s.costUsd
    totalTokens += s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreateTokens
    totalFiles += s.modifiedFilesCount
    totalRuns += s.runs
  }

  return (
    <section className="mb-4 rounded-lg border border-border bg-bg-secondary">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">Scheduled agents</div>
          {next ? (
            <div className="mt-0.5 text-xs text-text-secondary">
              Next: <span className="font-mono text-text-primary">{next.name}</span> {formatRelative(next.nextFireMs)}
            </div>
          ) : (
            <div className="mt-0.5 text-xs text-text-tertiary">No upcoming fires.</div>
          )}
        </div>
        {totalRuns > 0 && (
          <div className="text-xs text-text-secondary tabular-nums flex flex-wrap gap-x-3 gap-y-0.5">
            <span>{totalRuns} total runs</span>
            {totalTokens > 0 && <span>{formatTokens(totalTokens)} tok</span>}
            {totalCost > 0 && <span>{formatCost(totalCost)}</span>}
            {totalFiles > 0 && <span>{totalFiles} files touched</span>}
          </div>
        )}
        <button
          type="button"
          className="text-xs text-text-secondary hover:text-accent transition-colors cursor-pointer"
          onClick={() => goToAgents()}
        >
          Manage →
        </button>
      </header>
      <ul className="divide-y divide-border">
        {entries.map(e => {
          const stat = statsByName.get(e.name)
          const summary = stat ? statSummaryLine(stat) : []
          return (
            <li key={e.agentId}>
              <button
                type="button"
                onClick={() => goToAgents(e.agentId)}
                className="w-full px-3 py-2 flex items-center justify-between gap-3 text-left hover:bg-bg-tertiary/40 transition-colors cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-text-primary truncate">{e.name}</span>
                    <span className="text-[10px] px-1 py-px rounded bg-bg-tertiary text-text-tertiary font-mono">{e.schedule}</span>
                    {!e.enabled && <span className="text-[10px] px-1 py-px rounded bg-bg-tertiary text-text-tertiary">disabled</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-text-tertiary tabular-nums flex flex-wrap gap-x-3 gap-y-0.5">
                    {e.enabled && e.nextFireMs > 0 && <span>next {formatRelative(e.nextFireMs)}</span>}
                    {e.lastJobMs && <span>last run {formatRelative(e.lastJobMs)}</span>}
                    <span>fired {e.fireCount}×</span>
                    {e.errorCount > 0 && <span className="text-status-error">errors {e.errorCount}</span>}
                    {e.skippedCount > 0 && <span className="text-status-warning">skipped {e.skippedCount}</span>}
                  </div>
                  {summary.length > 0 && (
                    <div className="mt-0.5 text-[11px] text-text-secondary tabular-nums flex flex-wrap gap-x-3 gap-y-0.5">
                      {summary.map((s, i) => <span key={i}>{s}</span>)}
                    </div>
                  )}
                  {e.lastError && (
                    <div className="mt-0.5 text-[11px] text-status-error truncate">last error: {e.lastError}</div>
                  )}
                  {e.lastSkippedReason && !e.lastError && (
                    <div className="mt-0.5 text-[11px] text-status-warning truncate">skipped: {e.lastSkippedReason}</div>
                  )}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
