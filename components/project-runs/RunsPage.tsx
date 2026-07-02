'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchJobs } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'
import { buildEntries } from '@/components/project-runs/entries'
import {
  buildReleaseProgressLabel,
  buildReleaseSummary,
  flattenReleaseChildren,
} from '@/components/project-runs/release-progress'
import { groupWorkUnits } from '@/components/project-runs/work-units'
import { RUN_ROW_GRID_CLASS, RunRow } from '@/components/project-runs/RunRow'
import { formatCost, formatTokens, parseJobCountsResponse } from '@/components/project-runs/formatting'
import type { JobCountsResponse } from '@/components/project-runs/formatting'
import type { Entry } from '@/components/project-runs/types'
import { renderChain } from '@/components/project-runs/render-chain'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { InlineLoading } from '@/components/ui/InlineLoading'
import { Spinner } from '@/components/ui/Spinner'

const PAGE_SIZE = 100
const ROW_HEIGHT = 92
const HEADER_HEIGHT = 32
const OVERSCAN = 8

type DateFilter = '24h' | '7d' | '30d' | 'all'
type KindFilter =
  | 'all'
  | 'run'
  | 'agent'
  | 'release'
  | 'review'
  | 'test'
  | 'fix'
  | 'fix-ci'
  | 'commit'
  | 'push'
  | 'mark-dod'
  | 'pr-wait'
  | 'soak'

interface ProjectsResponse {
  tasks?: Array<{ project?: string }>
}

type VirtualItem =
  | { type: 'day'; key: string; label: string; height: number }
  | { type: 'entry'; key: string; entry: Entry; height: number }

function dateFrom(filter: DateFilter): number | undefined {
  const now = Math.floor(Date.now() / 1000)
  if (filter === '24h') return now - 24 * 60 * 60
  if (filter === '7d') return now - 7 * 24 * 60 * 60
  if (filter === '30d') return now - 30 * 24 * 60 * 60
  return undefined
}

function dayLabel(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function dayKey(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

function kindParams(kind: KindFilter): { kind?: string; kindPrefix?: string } {
  if (kind === 'all') return {}
  if (kind === 'agent') return { kindPrefix: 'agent:' }
  return { kind }
}

function countsUrl(project: string, date: DateFilter, kind: KindFilter): string {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  const from = dateFrom(date)
  if (typeof from === 'number') params.set('from', String(from))
  const kp = kindParams(kind)
  if (kp.kind) params.set('kind', kp.kind)
  if (kp.kindPrefix) params.set('kind_prefix', kp.kindPrefix)
  const qs = params.toString()
  return qs ? `/api/jobs/counts?${qs}` : '/api/jobs/counts'
}

function expandedChildCount(entry: Entry): number {
  if (entry.kind === 'release') return entry.children?.length ?? 0
  let count = 0
  for (const child of entry.chainedChildren ?? []) {
    if (child.kind === 'release') count += child.children?.length ?? 0
    else count += 1 + expandedChildCount(child)
  }
  count += entry.turnEntries?.length ?? 0
  return count
}

function buildVirtualItems(entries: Entry[], expanded: Set<string>): VirtualItem[] {
  const items: VirtualItem[] = []
  let lastDay = ''
  for (const entry of entries) {
    const key = dayKey(entry.lastActivityAt)
    if (key !== lastDay) {
      lastDay = key
      items.push({ type: 'day', key: `day:${key}`, label: dayLabel(entry.lastActivityAt), height: HEADER_HEIGHT })
    }
    const height = expanded.has(entry.key)
      ? ROW_HEIGHT + expandedChildCount(entry) * ROW_HEIGHT
      : ROW_HEIGHT
    items.push({ type: 'entry', key: entry.key, entry, height })
  }
  return items
}

function visibleRange(items: VirtualItem[], scrollTop: number, viewportHeight: number) {
  let offset = 0
  let start = 0
  while (start < items.length && offset + items[start].height < scrollTop) {
    offset += items[start].height
    start += 1
  }
  start = Math.max(0, start - OVERSCAN)
  let end = start
  let visibleHeight = 0
  while (end < items.length && visibleHeight < viewportHeight + OVERSCAN * ROW_HEIGHT * 2) {
    visibleHeight += items[end].height
    end += 1
  }
  return { start, end: Math.min(items.length, end + OVERSCAN) }
}

export function RunsPage() {
  const router = useRouter()
  const [project, setProject] = useState('')
  const [date, setDate] = useState<DateFilter>('7d')
  const [kind, setKind] = useState<KindFilter>('all')
  const [projects, setProjects] = useState<string[]>([])
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<JobCountsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(900)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const requestSeqRef = useRef(0)

  const query = useMemo(() => ({
    project: project || undefined,
    from: dateFrom(date),
    ...kindParams(kind),
  }), [date, kind, project])

  const loadPage = useCallback(async (offset: number) => {
    return fetchJobs(query.project, {
      limit: PAGE_SIZE,
      offset,
      from: query.from,
      kind: query.kind,
      kindPrefix: query.kindPrefix,
    })
  }, [query])

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  useEffect(() => {
    let active = true
    fetch('/api/projects')
      .then((res) => res.ok ? res.json() as Promise<ProjectsResponse> : { tasks: [] })
      .then((data) => {
        if (!active) return
        const names = new Set<string>()
        for (const task of data.tasks ?? []) {
          if (task.project) names.add(task.project)
        }
        setProjects([...names].sort((a, b) => a.localeCompare(b)))
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    const requestSeq = requestSeqRef.current + 1
    requestSeqRef.current = requestSeq
    setLoading(true)
    setJobs([])
    setTotal(0)
    setExpanded(new Set())
    setScrollTop(0)
    window.scrollTo({ top: 0 })
    Promise.all([
      loadPage(0),
      fetch(countsUrl(project, date, kind))
        .then((res) => res.ok ? res.json() : null)
        .then((data) => data ? parseJobCountsResponse(data) : null),
    ])
      .then(([page, counts]) => {
        if (!active || requestSeqRef.current !== requestSeq) return
        setTotal(page.total ?? page.jobs.length)
        setJobs(page.jobs)
        setSummary(counts)
      })
      .catch(() => {
        if (active && requestSeqRef.current === requestSeq) setSummary(null)
      })
      .finally(() => {
        if (active && requestSeqRef.current === requestSeq) setLoading(false)
      })
    return () => { active = false }
  }, [date, kind, loadPage, project])

  useEffect(() => {
    const update = () => {
      const top = containerRef.current?.getBoundingClientRect().top ?? 0
      setScrollTop(Math.max(0, -top))
      setViewportHeight(window.innerHeight)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  const entries = useMemo(() => buildEntries(jobs), [jobs])
  const groupedWorkUnits = useMemo(() => groupWorkUnits(entries), [entries])
  const displayEntries = kind === 'all' ? groupedWorkUnits.roots : entries
  const items = useMemo(() => buildVirtualItems(displayEntries, expanded), [displayEntries, expanded])
  const totalHeight = items.reduce((sum, item) => sum + item.height, 0)
  const range = visibleRange(items, scrollTop, viewportHeight)
  const topPad = items.slice(0, range.start).reduce((sum, item) => sum + item.height, 0)
  const visibleItems = items.slice(range.start, range.end)
  const bottomPad = Math.max(0, totalHeight - topPad - visibleItems.reduce((sum, item) => sum + item.height, 0))
  const hasMore = jobs.length < total
  const navigate = (entry: Entry) => {
    router.push(`/project/${encodeURIComponent(entry.project)}/history?job=${encodeURIComponent(entry.navJobId)}`)
  }

  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    const requestSeq = requestSeqRef.current
    const offset = jobs.length
    setLoadingMore(true)
    try {
      const data = await loadPage(offset)
      if (requestSeqRef.current !== requestSeq) return
      setTotal(data.total ?? data.jobs.length)
      setJobs((prev) => prev.length === offset ? [...prev, ...data.jobs] : prev)
    } finally {
      if (requestSeqRef.current === requestSeq) setLoadingMore(false)
    }
  }

  return (
    <main className="mx-auto max-w-[1440px] px-4 py-5">
      <div className="mb-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Runs</h1>
          <div className="mt-1 text-sm text-text-secondary">Cross-project run history with bounded server-side filters.</div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[560px]">
          <Select size="compact" value={project} onChange={(ev) => setProject(ev.target.value)} aria-label="Project filter">
            <option value="">All projects</option>
            {projects.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
          <Select size="compact" value={date} onChange={(ev) => setDate(ev.target.value as DateFilter)} aria-label="Date filter">
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </Select>
          <Select size="compact" value={kind} onChange={(ev) => setKind(ev.target.value as KindFilter)} aria-label="Kind filter">
            <option value="all">All kinds</option>
            <option value="agent">Agents</option>
            <option value="run">Chat</option>
            <option value="release">Release</option>
            <option value="review">Review</option>
            <option value="test">Test</option>
            <option value="fix">Fix</option>
            <option value="fix-ci">Fix CI</option>
            <option value="commit">Commit</option>
            <option value="push">Push</option>
            <option value="mark-dod">Mark DoD</option>
            <option value="pr-wait">PR wait</option>
            <option value="soak">Soak</option>
          </Select>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="rounded-md border border-border bg-bg-secondary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">runs</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-text-primary tabular-nums">{summary?.total ?? total}</div>
        </div>
        <div className="rounded-md border border-border bg-bg-secondary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">running</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-status-info tabular-nums">{summary?.byStatus.running ?? 0}</div>
        </div>
        <div className="rounded-md border border-border bg-bg-secondary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">tokens</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-text-primary tabular-nums">{formatTokens(summary?.tokens.total ?? 0)}</div>
        </div>
        <div className="rounded-md border border-border bg-bg-secondary px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">spend</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-accent tabular-nums">{formatCost(summary?.cost.total ?? 0)}</div>
        </div>
      </div>

      {loading ? (
        <InlineLoading
          label="Loading runs"
          className="justify-center rounded-lg border border-border bg-bg-secondary py-12 text-text-secondary"
        />
      ) : entries.length === 0 ? (
        <EmptyState title="No runs match these filters" description="Adjust the project, date, or kind filter." />
      ) : (
        <>
          <div ref={containerRef} className={`overflow-hidden rounded-lg border border-border bg-bg-primary lg:grid ${RUN_ROW_GRID_CLASS} lg:gap-x-3`}>
            <div className="hidden border-b border-border bg-bg-secondary pl-4 pr-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-tertiary lg:col-span-full lg:grid lg:grid-cols-subgrid lg:gap-x-3">
              <span>wanted</span>
              <span>done / progress</span>
              <span className="text-right">duration</span>
              <span className="text-right">usage</span>
              <span className="text-right">actions</span>
            </div>
            {topPad > 0 && <div aria-hidden className="lg:col-span-full" style={{ height: topPad }} />}
            {visibleItems.map((item) => item.type === 'day' ? (
              <div key={item.key} className="border-b border-border bg-bg-secondary/70 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary lg:col-span-full">
                {item.label}
              </div>
            ) : (() => {
              const entry = item.entry
              const hasChainedKids = (entry.chainedChildren?.length ?? 0) > 0
              const hasTurnBreakdown = (entry.turnEntries?.length ?? 0) > 1
              const isReleaseParent = entry.kind === 'release' && (entry.children?.length ?? 0) > 0
              const isExpandable = isReleaseParent || hasChainedKids || hasTurnBreakdown
              const isExpanded = expanded.has(entry.key)
              const ownedRelease = hasChainedKids && !isReleaseParent
                ? entry.chainedChildren?.find((child) => child.kind === 'release')
                : null
              const rowSummary = isReleaseParent
                ? buildReleaseSummary(entry.children ?? [], entry)
                : ownedRelease
                  ? buildReleaseSummary(ownedRelease.children ?? [], ownedRelease)
                  : null
              const rowProgressLabel = isReleaseParent
                ? buildReleaseProgressLabel(entry.children ?? [], entry)
                : ownedRelease
                  ? buildReleaseProgressLabel(ownedRelease.children ?? [], ownedRelease)
                  : null
              return (
                <RunRow
                  key={item.key}
                  entry={entry}
                  showProject
                  onClick={() => navigate(entry)}
                  expandable={isExpandable}
                  expanded={isExpanded}
                  onToggleExpand={() => toggleExpanded(entry.key)}
                  summary={rowSummary}
                  progressLabel={rowProgressLabel}
                >
                  {isExpandable && isExpanded && (
                    <div className="bg-bg-primary/40 lg:col-span-full lg:grid lg:grid-cols-subgrid lg:gap-x-3">
                      {isReleaseParent
                        ? flattenReleaseChildren(entry.children ?? [], 1).map(({ entry: child, depth }) => (
                            <RunRow key={child.key} entry={child} onClick={() => navigate(child)} depth={depth} showProject />
                          ))
                        : (
                          <>
                            {(entry.chainedChildren ?? []).map((root) =>
                              root.kind === 'release'
                                ? (
                                    <Fragment key={root.key}>
                                      {flattenReleaseChildren(root.children ?? [], 1).map(({ entry: child, depth }) => (
                                        <RunRow key={child.key} entry={child} onClick={() => navigate(child)} depth={depth} showProject />
                                      ))}
                                    </Fragment>
                                  )
                                : renderChain(root, 1, navigate, () => null, true)
                            )}
                            {hasTurnBreakdown && [...entry.turnEntries!]
                              .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
                              .map((turn) => (
                                <RunRow key={turn.key} entry={turn} onClick={() => navigate(turn)} depth={1} showProject />
                              ))}
                          </>
                        )
                      }
                    </div>
                  )}
                </RunRow>
              )
            })())}
            {bottomPad > 0 && <div aria-hidden className="lg:col-span-full" style={{ height: bottomPad }} />}
          </div>
          {hasMore && (
            <div className="flex justify-center py-4">
              <Button type="button" variant="secondary" size="md" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? (
                  <>
                    <Spinner size="sm" shrink aria-label="Loading" role="status" />
                    <span>Loading...</span>
                  </>
                ) : (
                  `Load older (${total - jobs.length} remaining)`
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  )
}
