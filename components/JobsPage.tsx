'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { fetchJobs, fetchProjects } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'
import { resolveGithubBoardUrl } from '@/lib/client/resolve-github-board-url'
import {
  buildEntries,
  groupReleaseChildren,
  buildReleaseSummary,
  buildReleaseProgressLabel,
  flattenReleaseChildren,
  dayKey,
  dayLabel,
  formatTokens,
  formatCost,
  KIND_LABEL,
  entryIsRunning,
  entryNeedsAttention,
  parseJobCountsResponse,
} from '@/components/project-runs/utils'
import type { Entry, JobCountsResponse, KindBucket } from '@/components/project-runs/utils'
import { RunRow } from '@/components/project-runs/RunRow'
import { RunsPageEmptyState, RunsPageLoadingState } from '@/components/project-runs/RunsPageStates'

const RUNS_PAGE_LIMIT = 200

type Filter =
  | { kind: 'all' }
  | { kind: 'running' }
  | { kind: 'done' }
  | { kind: 'failed' }
  | { kind: 'bucket'; bucket: KindBucket }

function filterKey(f: Filter): string {
  return f.kind === 'bucket' ? `b:${f.bucket}` : f.kind
}

function renderChain(node: Entry, depth: number, navigate: (e: Entry) => void): React.ReactNode {
  const summary = node.kind === 'release'
    ? buildReleaseSummary(node.children ?? [], node)
    : null
  const progressLabel = node.kind === 'release'
    ? buildReleaseProgressLabel(node.children ?? [], node)
    : null
  const pipelineFlat = node.kind === 'release'
    ? flattenReleaseChildren(node.children ?? [], depth + 1)
    : []
  return (
    <Fragment key={node.key}>
      <RunRow entry={node} onClick={() => navigate(node)} depth={depth} summary={summary} progressLabel={progressLabel} />
      {node.kind === 'release'
        ? pipelineFlat.map(({ entry, depth: d }) => (
            <RunRow key={entry.key} entry={entry} onClick={() => navigate(entry)} depth={d} />
          ))
        : node.chainedChildren?.map((c) =>
            c.kind === 'release'
              // Skip the release wrapper row when it appears as a chained
              // child of something else — fold its phases inline so the
              // workflow reads as one continuous chain.
              ? flattenReleaseChildren(c.children ?? [], depth + 1).map(({ entry, depth: d }) => (
                  <RunRow key={entry.key} entry={entry} onClick={() => navigate(entry)} depth={d} />
                ))
              : renderChain(c, depth + 1, navigate)
          )
      }
    </Fragment>
  )
}

export function JobsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const projectFilter = searchParams.get('project') || ''
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [totalRuns, setTotalRuns] = useState(0)
  const [projects, setProjects] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [boardUrl, setBoardUrl] = useState<string>('')
  const [summary, setSummary] = useState<JobCountsResponse | null>(null)

  useEffect(() => {
    let active = true
    fetchProjects()
      .then((data) => {
        if (!active) return
        setProjects(data.tasks.map((task) => task.id).sort((a, b) => a.localeCompare(b)))
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        const s = data?.settings ?? data
        setBoardUrl(resolveGithubBoardUrl(s))
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const data = await fetchJobs(projectFilter || undefined, { limit: RUNS_PAGE_LIMIT })
        if (!active) return
        const sorted = data.jobs.sort((a, b) => b.started_at - a.started_at)
        setJobs(sorted)
        setTotalRuns(data.total ?? sorted.length)
        // Prefer the dedicated counts endpoint for the header total once it
        // has answered; the list endpoint's `total` is filter-aware and won't
        // include statuses outside the current page.
        setLoading(false)
      } catch {
        if (active) setLoading(false)
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [projectFilter])

  // Aggregate counts come from /api/jobs/counts for header text. Filter chips
  // stay tied to loaded rows so clicking a chip can actually show its rows.
  useEffect(() => {
    let active = true
    const loadSummary = async () => {
      try {
        const url = projectFilter
          ? `/api/jobs/counts?project=${encodeURIComponent(projectFilter)}`
          : '/api/jobs/counts'
        const res = await fetch(url)
        if (!res.ok) return
        const data = parseJobCountsResponse(await res.json())
        if (active) setSummary(data)
      } catch {}
    }
    loadSummary()
    const interval = setInterval(loadSummary, 15000)
    return () => { active = false; clearInterval(interval) }
  }, [projectFilter])

  const entries = useMemo(() => buildEntries(jobs), [jobs])
  const groupedEntries = useMemo(() => groupReleaseChildren(entries), [entries])

  const loadedCounts = useMemo(() => {
    const c = {
      all: entries.length, running: 0, done: 0, failed: 0,
      run: 0, release: 0, review: 0, test: 0, fix: 0, 'fix-ci': 0,
      commit: 0, push: 0, 'mark-dod': 0, 'pr-wait': 0, agent: 0, other: 0,
    } as Record<string, number>
    for (const e of entries) {
      c[e.bucket] += 1
      if (entryIsRunning(e)) c.running += 1
      else if (entryNeedsAttention(e)) c.failed += 1
      else c.done += 1
    }
    return c
  }, [entries])

  const matches = (e: Entry, f: Filter): boolean => {
    if (f.kind === 'all') return true
    if (f.kind === 'running') return entryIsRunning(e)
    if (f.kind === 'done') return !entryIsRunning(e) && !entryNeedsAttention(e)
    if (f.kind === 'failed') return entryNeedsAttention(e)
    return e.bucket === f.bucket
  }

  const shouldGroup = (f: Filter): boolean => {
    if (f.kind === 'all' || f.kind === 'running' || f.kind === 'done' || f.kind === 'failed') return true
    if (f.kind === 'bucket' && f.bucket === 'release') return true
    return false
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const source = shouldGroup(filter) ? groupedEntries : entries
    return source.filter((e) => {
      if (!matches(e, filter)) return false
      if (!q) return true
      const hay = `${e.project} ${e.title} ${e.subtitle ?? ''} ${e.releaseOutcome?.label ?? ''} ${e.model ?? ''} ${e.navSessionId ?? ''} ${e.kind}`.toLowerCase()
      return hay.includes(q)
    })
  }, [entries, filter, groupedEntries, search])

  const groups = useMemo(() => {
    const m = new Map<string, { label: string; items: Entry[]; ts: number }>()
    for (const e of filtered) {
      const k = dayKey(e.lastActivityAt)
      const g = m.get(k)
      if (g) g.items.push(e)
      else m.set(k, { label: dayLabel(e.lastActivityAt), items: [e], ts: e.lastActivityAt })
    }
    return Array.from(m.values()).sort((a, b) => b.ts - a.ts)
  }, [filtered])

  const totals = useMemo(() => {
    let tokens = 0, running = 0, durationMs = 0, costUsd = 0
    for (const e of filtered) {
      tokens += e.inputTokens + e.outputTokens
      durationMs += e.durationMs ?? 0
      costUsd += e.costUsd
      if (entryIsRunning(e)) running += 1
    }
    return { tokens, running, durationMs, costUsd }
  }, [filtered])
  const loadedSummary = jobs.length < totalRuns
    ? `${jobs.length} loaded`
    : `${filtered.length} grouped entr${filtered.length === 1 ? 'y' : 'ies'}`
  const headerTotal = summary?.total ?? totalRuns
  const headerRunning = summary?.byStatus.running ?? totals.running
  const activeFilterLabel = filter.kind === 'bucket' ? KIND_LABEL[filter.bucket] : filter.kind
  const emptyStateMode = entries.length === 0
    ? 'empty'
    : search.trim()
    ? 'search'
    : filter.kind === 'running'
    ? 'running'
    : filter.kind === 'failed'
    ? 'failed'
    : filter.kind === 'done'
    ? 'done'
    : 'filtered'

  const navigate = (e: Entry) => {
    if (e.bucket === 'run' && e.navSessionId && e.kind !== 'release') {
      router.push(`/project/${e.project}/terminal/${e.navSessionId}`)
    } else {
      router.push(`/project/${e.project}/terminal?job=${encodeURIComponent(e.navJobId)}`)
    }
  }

  const setProjectFilter = (project: string) => {
    router.push(project ? `/runs?project=${encodeURIComponent(project)}` : '/runs')
  }

  const clearView = () => {
    setSearch('')
    setFilter({ kind: 'all' })
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Runs</h2>
          <div className="mt-1 text-xs text-text-tertiary font-mono">
            {headerTotal} total run{headerTotal === 1 ? '' : 's'} · {loadedSummary}
            {headerRunning > 0 && (
              <> · <span className="text-status-info">{headerRunning} running</span></>
            )}
            {(summary?.tokens.total ?? totals.tokens) > 0 && <> · {formatTokens(summary?.tokens.total ?? totals.tokens)} tok</>}
            {(summary?.cost.total ?? totals.costUsd) > 0 && <> · <span className="text-accent">{formatCost(summary?.cost.total ?? totals.costUsd)}</span></>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {boardUrl && (
            <a
              href={boardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-border bg-bg-secondary text-text-secondary hover:text-accent hover:border-accent/40 transition-colors"
              title="Open the TamTam project board on GitHub"
            >
              Board ↗
            </a>
          )}
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg-secondary text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors max-w-[260px]"
            title="Filter runs by project"
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project} value={project}>{project}</option>
            ))}
          </select>
          <input
            type="search"
            placeholder="Search project, prompt, model…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-md border border-border bg-bg-secondary text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors w-64"
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto mb-3 pb-0.5 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent" style={{ scrollbarWidth: 'thin' }}>
          {([
          { f: { kind: 'all' } as Filter, label: 'all', tone: 'neutral' },
          { f: { kind: 'running' } as Filter, label: 'running', tone: 'info' },
          { f: { kind: 'failed' } as Filter, label: 'failed', tone: 'error' },
          { f: { kind: 'done' } as Filter, label: 'done', tone: 'success' },
        ] as const).map(({ f, label, tone }) => {
          const count = loadedCounts[f.kind] ?? 0
          if ((f.kind === 'running' || f.kind === 'failed') && count === 0 && filterKey(filter) !== filterKey(f)) return null
          const active = filterKey(filter) === filterKey(f)
          const toneCls =
            tone === 'info' ? (active ? 'border-status-info bg-status-info/15 text-status-info' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-info') :
            tone === 'error' ? (active ? 'border-status-error bg-status-error/15 text-status-error' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-error') :
            tone === 'success' ? (active ? 'border-status-success bg-status-success/15 text-status-success' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-success') :
            (active ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary')
          return (
            <button
              key={label}
              className={`shrink-0 px-2.5 py-1 text-xs rounded-full font-mono cursor-pointer border ${toneCls}`}
              onClick={() => setFilter(f)}
            >
              {label} <span className="opacity-70">{count}</span>
            </button>
          )
        })}
        <span className="shrink-0 h-5 w-px bg-border mx-1" aria-hidden />
        {(['run', 'release', 'review', 'test', 'fix', 'fix-ci', 'commit', 'push', 'mark-dod', 'pr-wait', 'agent', 'other'] as const).map((b) => {
          const count = loadedCounts[b] ?? 0
          const active = filter.kind === 'bucket' && filter.bucket === b
          if (count === 0 && !active) return null
          return (
            <button
              key={b}
              className={`shrink-0 px-2.5 py-1 text-xs rounded-full font-mono cursor-pointer border ${
                active
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
              }`}
              onClick={() => setFilter({ kind: 'bucket', bucket: b })}
            >
              {KIND_LABEL[b]} <span className="opacity-70">{count}</span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <RunsPageLoadingState />
      ) : filtered.length === 0 ? (
        <RunsPageEmptyState
          mode={emptyStateMode}
          search={search}
          activeFilterLabel={activeFilterLabel}
          totalEntries={entries.length}
          runningCount={loadedCounts.running}
          failedCount={loadedCounts.failed}
          projectScopeLabel={projectFilter || 'all projects'}
          onClearView={clearView}
          onResetScope={projectFilter ? () => setProjectFilter('') : undefined}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="flex items-center gap-2 mb-1.5 px-1">
                <span className="text-[11px] uppercase tracking-wider text-text-tertiary font-semibold">{g.label}</span>
                <span className="text-[11px] text-text-tertiary font-mono">· {g.items.length}</span>
                <div className="flex-1 h-px bg-border/60" />
              </div>
              <div className="border border-border rounded-lg overflow-hidden bg-bg-secondary">
                {g.items.map((e) => {
                  const hasChainedKids = (e.chainedChildren?.length ?? 0) > 0
                  const isReleaseParent = e.kind === 'release' && (e.children?.length ?? 0) > 0
                  const isExpandable = isReleaseParent || hasChainedKids
                  const isExpanded = expanded.has(e.key)
                  const ownedRelease = hasChainedKids && !isReleaseParent
                    ? e.chainedChildren?.find(c => c.kind === 'release')
                    : null
                  const rowSummary = isReleaseParent
                    ? buildReleaseSummary(e.children ?? [], e)
                    : ownedRelease
                      ? buildReleaseSummary(ownedRelease.children ?? [], ownedRelease)
                      : null
                  const rowProgressLabel = isReleaseParent
                    ? buildReleaseProgressLabel(e.children ?? [], e)
                    : ownedRelease
                      ? buildReleaseProgressLabel(ownedRelease.children ?? [], ownedRelease)
                      : null
                  return (
                    <RunRow
                      key={e.key}
                      entry={{ ...e, title: projectFilter ? e.title : `${e.project} · ${e.title}` }}
                      onClick={() => navigate(e)}
                      expandable={isExpandable}
                      expanded={isExpanded}
                      onToggleExpand={() => {
                        setExpanded((prev) => {
                          const next = new Set(prev)
                          if (next.has(e.key)) next.delete(e.key)
                          else next.add(e.key)
                          return next
                        })
                      }}
                      summary={rowSummary}
                      progressLabel={rowProgressLabel}
                    >
                      {isExpandable && isExpanded && (
                        <div className="bg-bg-primary/40">
                          {/* When an agent owns a release in chainedChildren, fold the release's
                              phases directly under the agent — the release row is a wrapper
                              concept the user doesn't need to see as a separate step. */}
                          {isReleaseParent
                            ? flattenReleaseChildren(e.children ?? [], 1).map(({ entry, depth: d }) => (
                                <RunRow key={entry.key} entry={entry} onClick={() => navigate(entry)} depth={d} />
                              ))
                            : e.chainedChildren?.map((c) =>
                                c.kind === 'release'
                                  ? flattenReleaseChildren(c.children ?? [], 1).map(({ entry, depth: d }) => (
                                      <RunRow key={entry.key} entry={entry} onClick={() => navigate(entry)} depth={d} />
                                    ))
                                  : renderChain(c, 1, navigate)
                              )
                          }
                        </div>
                      )}
                    </RunRow>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
