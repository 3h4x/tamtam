'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  fetchJobs,
  fetchAutomationQueue,
} from '@/lib/client-api'
import type { AutomationQueueItem, JobInfo } from '@/lib/client-api'
import { Button, buttonVariants } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { Spinner } from '@/components/ui/Spinner'
import {
  dayKey,
  dayLabel,
  parseJobCountsResponse,
} from '@/components/project-runs/formatting'
import {
  buildEntries,
  entryIsRunning,
  entryNeedsAttention,
  latestReleaseKey,
} from '@/components/project-runs/entries'
import {
  buildReleaseSummary,
  buildReleaseProgressLabel,
} from '@/components/project-runs/release-progress'
import { groupWorkUnits, mergeWorkUnits } from '@/components/project-runs/work-units'
import {
  KIND_LABEL,
} from '@/components/project-runs/kinds'
import type { JobCountsResponse } from '@/components/project-runs/formatting'
import type { Entry } from '@/components/project-runs/types'
import { RunUnitRow } from '@/components/project-runs/RunUnitRow'
import { RunDetailDrawer } from '@/components/project-runs/RunDetailDrawer'
import { ProjectRunsEmptyState, ProjectRunsLoadingState } from '@/components/project-runs/RunStates'
import { mergeJobs, reconcileRefreshJobs } from '@/components/project-runs/refresh'
import { RunsHeader } from '@/components/project-runs/RunsHeader'
import type { Filter } from '@/components/project-runs/filters'
import { useRunActions } from '@/hooks/useRunActions'

interface ProjectRunsTabProps {
  projectName: string
  jobsPaused?: boolean
}

const PAGE_SIZE = 50
const MAX_REFRESH_PAGE_SIZE = 200
const ACTIVE_POLL_MS = 5000
const IDLE_POLL_MS = 1000

export function ProjectRunsTab({ projectName, jobsPaused = false }: ProjectRunsTabProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [pendingReleaseQueued, setPendingReleaseQueued] = useState(false)
  const [queueItems, setQueueItems] = useState<AutomationQueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [totalJobs, setTotalJobs] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [summary, setSummary] = useState<JobCountsResponse | null>(null)
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [search, setSearch] = useState('')
  const [showAllJobs, setShowAllJobs] = useState(false)
  // Retained only so useRunActions can auto-expand a release after a retry.
  // The flat feed has no inline expansion, so this is otherwise inert.
  const [, setExpanded] = useState<Set<string>>(new Set())

  // Track the current window size in a ref so the polling closure can read
  // it without forcing a re-mounted interval on every state change.
  const windowSizeRef = useRef<number>(PAGE_SIZE)
  windowSizeRef.current = Math.max(PAGE_SIZE, jobs.length)
  const jobsRef = useRef<JobInfo[]>([])
  jobsRef.current = jobs

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    setJobs([])
    setPendingReleaseQueued(false)
    setLoading(true)
    setTotalJobs(0)
    setSummary(null)
    setExpanded(new Set())
    const scheduleNext = () => {
      if (!active) return
      const hasRunningJob = jobsRef.current.some((job) => job.status === 'running')
      timer = setTimeout(() => {
        void poll()
      }, hasRunningJob ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    }
    const poll = async () => {
      try {
        // Refresh only the rows already on screen so 5s polling doesn't
        // re-download the full history each tick.
        const windowSize = windowSizeRef.current
        const refreshLimit = Math.min(windowSize, MAX_REFRESH_PAGE_SIZE)
        const data = await fetchJobs(projectName, { limit: refreshLimit })
        if (active) {
          setJobs((prev) => reconcileRefreshJobs(data.jobs, prev, windowSize, data.total, refreshLimit))
          setTotalJobs(data.total ?? data.jobs.length)
          setPendingReleaseQueued(!!data.pendingReleaseProjects?.includes(projectName))
          setLoading(false)
        }
      } catch {}
      finally {
        scheduleNext()
      }
    }
    void poll()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [projectName])

  useEffect(() => {
    let active = true
    setQueueItems([])
    const poll = async () => {
      try {
        const data = await fetchAutomationQueue(projectName)
        if (active) setQueueItems(data.items)
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 10000)
    return () => { active = false; clearInterval(interval) }
  }, [projectName])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleNext = () => {
      if (!active) return
      const hasRunningJob = jobsRef.current.some((job) => job.status === 'running')
      timer = setTimeout(() => {
        void loadCounts()
      }, hasRunningJob ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    }
    const loadCounts = async () => {
      try {
        const res = await fetch(`/api/jobs/counts?project=${encodeURIComponent(projectName)}`)
        if (!res.ok) return
        const data = parseJobCountsResponse(await res.json())
        if (active) setSummary(data)
      } catch {}
      finally {
        scheduleNext()
      }
    }
    void loadCounts()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [projectName])

  const hasMore = totalJobs > jobs.length
  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const data = await fetchJobs(projectName, { limit: PAGE_SIZE, offset: jobs.length })
      setJobs((prev) => mergeJobs(data.jobs, prev, prev.length + data.jobs.length))
      setTotalJobs(data.total ?? jobs.length + data.jobs.length)
    } finally {
      setLoadingMore(false)
    }
  }

  const entries = useMemo(() => buildEntries(jobs), [jobs])
  const groupedWorkUnits = useMemo(() => groupWorkUnits(entries), [entries])
  const groupedEntries = groupedWorkUnits.roots
  // Latest release per project — used to gate the "Continue release" /
  // "Retry release" actions so they only appear on the most recent release
  // entry. Once a newer release ran, retrying an older failed one is
  // misleading: the project state has moved on.
  const latestTopLevelReleaseKey = useMemo(() => latestReleaseKey(groupedEntries), [groupedEntries])
  const loadJobs = async () => {
    const windowSize = Math.max(PAGE_SIZE, jobs.length)
    const refreshLimit = Math.min(windowSize, MAX_REFRESH_PAGE_SIZE)
    const data = await fetchJobs(projectName, { limit: refreshLimit })
    setJobs((prev) => reconcileRefreshJobs(data.jobs, prev, windowSize, data.total, refreshLimit))
    setTotalJobs(data.total ?? data.jobs.length)
    setPendingReleaseQueued(!!data.pendingReleaseProjects?.includes(projectName))
    await loadQueue()
    setLoading(false)
    return data
  }

  const loadQueue = async () => {
    const data = await fetchAutomationQueue(projectName)
    setQueueItems(data.items)
    return data
  }

  const selectedJobId = searchParams?.get('job') ?? null
  const updateSelectedJob = useCallback((jobId: string | null) => {
    const next = new URLSearchParams(searchParams?.toString() ?? '')
    if (jobId) next.set('job', jobId)
    else next.delete('job')
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }, [pathname, router, searchParams])
  const openRunDetail = useCallback((e: Entry) => {
    updateSelectedJob(e.navJobId)
  }, [updateSelectedJob])

  const { releaseActionsFor, queueActionState, retryQueuedWork, cancelQueuedWork } = useRunActions({
    projectName,
    jobsPaused,
    latestTopLevelReleaseKey,
    loadJobs,
    loadQueue,
    setQueueItems,
    setExpanded,
  })

  // Counts reflect the flat entry list (pre-grouping) so the chip numbers
  // match what you'd see if you clicked into that filter.
  const counts = useMemo(() => {
    const c = {
      all: entries.length, running: 0, failed: 0,
      run: 0, release: 0, review: 0, test: 0, fix: 0, 'fix-ci': 0,
      commit: 0, push: 0, 'mark-dod': 0, 'pr-wait': 0, soak: 0, agent: 0, other: 0,
    } as Record<string, number>
    for (const e of entries) {
      c[e.bucket] += 1
      if (entryIsRunning(e)) c.running += 1
      else if (entryNeedsAttention(e)) c.failed += 1
    }
    return c
  }, [entries])

  const matches = (e: Entry, f: Filter): boolean => {
    if (f.kind === 'all') return true
    if (f.kind === 'running') return entryIsRunning(e)
    if (f.kind === 'failed') return entryNeedsAttention(e)
    return e.bucket === f.bucket
  }

  // Grouping applies on tabs where you want a pipeline-level view: the default
  // "all" tab and the status shortcuts. Kind-specific tabs are flat so clicking
  // e.g. "test" shows every test run, including those that were release children.
  const shouldGroup = (f: Filter): boolean => {
    if (f.kind === 'all' || f.kind === 'running' || f.kind === 'failed') return true
    if (f.kind === 'bucket' && f.bucket === 'release') return true
    return false
  }

  const groupingActive = shouldGroup(filter)
  const hiddenInternalCount = groupedWorkUnits.internal.length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    // Grouped views hide internal plumbing (mark-dod-verify) unless "show all
    // jobs" is on. Kind-specific filters show the flat entry list so the picked
    // kind is exhaustive (including release children and internal jobs).
    const source = shouldGroup(filter)
      ? (showAllJobs ? mergeWorkUnits(groupedWorkUnits) : groupedWorkUnits.roots)
      : entries
    return source.filter((e) => {
      if (!matches(e, filter)) return false
      if (!q) return true
      const hay = `${e.title} ${e.subtitle ?? ''} ${e.releaseOutcome?.label ?? ''} ${e.model ?? ''} ${e.navSessionId ?? ''} ${e.kind}`.toLowerCase()
      return hay.includes(q)
    })
  }, [entries, filter, groupedWorkUnits, showAllJobs, search])

  // Group filtered entries by day for scannability.
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

  const loadedTotals = useMemo(() => {
    let tokens = 0, running = 0, costUsd = 0
    for (const e of filtered) {
      tokens += e.inputTokens + e.outputTokens
      costUsd += e.costUsd
      if (entryIsRunning(e)) running += 1
    }
    return { tokens, running, costUsd }
  }, [filtered])

  // Cost-to-date headers come from the lightweight counts endpoint, not from
  // walking the (now paginated) jobs list — otherwise totals would only
  // reflect the rows currently in memory. Fall back to loaded rows when the
  // counts response is missing or malformed.
  const loadedMonthCost = useMemo(() => {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000
    return entries.reduce((sum, e) => sum + (e.startedAt >= monthStart ? e.costUsd : 0), 0)
  }, [entries])
  const thisMonthCost = summary?.cost.monthToDate ?? loadedMonthCost
  const activeFilterLabel = filter.kind === 'bucket' ? KIND_LABEL[filter.bucket] : filter.kind
  const emptyStateMode = entries.length === 0
    ? 'empty'
    : search.trim()
    ? 'search'
    : filter.kind === 'running'
    ? 'running'
    : filter.kind === 'failed'
    ? 'failed'
    : 'filtered'

  return (
    <div className="mt-4">
      {/* Release-queued banner: an agent/run finished and tried to trigger
          a release while another release was in flight (or jobs were paused)
          — the request was queued and will fire once the lock releases. */}
      {pendingReleaseQueued && (
        <Link
          href={`/pipeline?project=${encodeURIComponent(projectName)}`}
          className={buttonVariants({
            variant: 'primary',
            size: 'sm',
            className: 'mb-3 flex rounded-md border-accent/30 bg-accent/5 px-3 py-2 hover:bg-accent/10',
          })}
        >
          <span className="font-mono">↦</span>
          <span>Release queued — will fire automatically when the running pipeline finishes (or jobs resume).</span>
        </Link>
      )}
      {queueItems.length > 0 && (
        <ErrorCallout tone="warning" padding="none" radius="lg" preWrap={false} className="mb-3 !bg-status-warning/5">
          <div className="flex items-center justify-between gap-3 border-b border-status-warning/20 px-3 py-2">
            <div>
              <div className="text-xs font-medium text-text-primary">Queued automation</div>
              <div className="text-[11px] text-text-tertiary">Retry or cancel deferred releases and agent runs for this project.</div>
            </div>
            <Link
              href={`/pipeline?project=${encodeURIComponent(projectName)}`}
              className={buttonVariants({
                variant: 'link',
                size: 'sm',
                className: 'text-[11px] hover:text-accent-hover hover:no-underline',
              })}
            >
              Pipeline
            </Link>
          </div>
          <div className="divide-y divide-status-warning/20">
            {queueItems.map((item) => {
              const active = queueActionState?.itemId === item.id
              const queuedAt = item.queuedAt
                ? new Date(item.queuedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
                : 'unknown time'
              return (
                <div key={item.id} className="grid gap-2 px-3 py-2 md:grid-cols-[1fr_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-text-primary">{item.label}</span>
                      <span className="font-mono text-[10px] text-text-tertiary">{item.code}</span>
                      {item.blockingJobId && (
                        <span className="font-mono text-[10px] text-status-warning">blocked by {item.blockingJobId.slice(-12)}</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-text-tertiary">
                      {item.reason} · queued {queuedAt}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 md:justify-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      disabled={active || !item.retryAllowed}
                      onClick={() => retryQueuedWork(item)}
                      title={item.retryAllowed ? 'Run the recovery drain now' : 'Retry is not available for this queue item'}
                    >
                      {active ? queueActionState?.label : 'Retry'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      disabled={active || !item.cancelAllowed}
                      onClick={() => cancelQueuedWork(item)}
                      title={item.cancelAllowed ? 'Remove this queued item without stopping active jobs' : 'Cancel is not available for this queue item'}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </ErrorCallout>
      )}
      <RunsHeader
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
        onClearFilters={() => { setSearch(''); setFilter({ kind: 'all' }) }}
        filteredCount={filtered.length}
        entriesCount={entries.length}
        totalJobs={totalJobs}
        summary={summary}
        loadedTotals={loadedTotals}
        thisMonthCost={thisMonthCost}
        counts={counts}
        groupingActive={groupingActive}
        showAllJobs={showAllJobs}
        onToggleShowAll={() => setShowAllJobs((v) => !v)}
        hiddenInternalCount={hiddenInternalCount}
      />

      {loading ? (
        <ProjectRunsLoadingState />
      ) : filtered.length === 0 ? (
        <ProjectRunsEmptyState
          projectName={projectName}
          mode={emptyStateMode}
          search={search}
          activeFilterLabel={activeFilterLabel}
          totalEntries={summary?.total ?? entries.length}
          runningCount={summary?.byStatus.running ?? loadedTotals.running}
          failedCount={counts.failed}
          onClearFilters={() => { setSearch(''); setFilter({ kind: 'all' }) }}
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
              <div className="overflow-hidden rounded-lg border border-border bg-bg-primary">
                {g.items.map((e) => {
                  // A release row (or an agent/run row that owns a release)
                  // surfaces the pipeline recap + progress inline; the full
                  // step timeline lives in the detail drawer.
                  const ownedRelease = e.kind !== 'release'
                    ? e.chainedChildren?.find((c) => c.kind === 'release') ?? null
                    : null
                  const releaseSource = e.kind === 'release' ? e : ownedRelease
                  const rowSummary = releaseSource
                    ? buildReleaseSummary(releaseSource.children ?? [], releaseSource)
                    : null
                  const rowProgressLabel = releaseSource
                    ? buildReleaseProgressLabel(releaseSource.children ?? [], releaseSource)
                    : null
                  return (
                    <RunUnitRow
                      key={e.key}
                      entry={e}
                      onClick={() => openRunDetail(e)}
                      summary={rowSummary}
                      progressLabel={rowProgressLabel}
                      actions={releaseActionsFor(e)}
                    />
                  )
                })}
              </div>
            </div>
          ))}
          {hasMore && (
            <div className="flex justify-center py-3">
              <Button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                variant="secondary"
                size="md"
              >
                {loadingMore ? (
                  <>
                    <Spinner size="sm" shrink aria-label="Loading" role="status" />
                    <span>Loading...</span>
                  </>
                ) : (
                  `Load older (${totalJobs - jobs.length} remaining)`
                )}
              </Button>
            </div>
          )}
        </div>
      )}
      <RunDetailDrawer
        projectName={projectName}
        jobId={selectedJobId}
        onClose={() => updateSelectedJob(null)}
      />
    </div>
  )
}
