'use client'

import { Fragment, useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { fetchJobs, releaseProject, pushProject, syncJobBoard } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'
import {
  formatTokens,
  formatCost,
  dayKey,
  dayLabel,
  buildEntries,
  groupReleaseChildren,
  buildReleaseSummary,
  flattenPipelineSteps,
  KIND_LABEL,
  entryIsRunning,
  entryNeedsAttention,
  latestReleaseKey,
  PIPELINE_CHILD_KINDS,
} from '@/components/project-runs/utils'
import type { Entry, KindBucket } from '@/components/project-runs/utils'
import { RunRow } from '@/components/project-runs/RunRow'

interface ProjectRunsTabProps {
  projectName: string
  jobsPaused?: boolean
}

// One-axis filter: either a kind bucket, or a status shortcut.
type Filter =
  | { kind: 'all' }
  | { kind: 'running' }
  | { kind: 'failed' }
  | { kind: 'bucket'; bucket: KindBucket }

function filterKey(f: Filter): string {
  return f.kind === 'bucket' ? `b:${f.bucket}` : f.kind
}

// Render a chained-child node (e.g. a release nested under an agent run).
// For release nodes the pipeline steps are flattened so test/review/commit/push
// all appear at the same depth; fix/fix-push are one level deeper.
function renderChain(
  node: Entry,
  depth: number,
  navigate: (e: Entry) => void,
  actionsFor: (e: Entry) => React.ReactNode,
): React.ReactNode {
  const summary = node.kind === 'release'
    ? buildReleaseSummary(node.children ?? [], node)
    : null
  const pipelineFlat = node.kind === 'release'
    ? flattenPipelineSteps(node.chainedChildren ?? [], depth + 1)
    : []
  return (
    <Fragment key={node.key}>
      <RunRow
        entry={node}
        onClick={() => navigate(node)}
        depth={depth}
        summary={summary}
        actions={actionsFor(node)}
      />
      {node.kind === 'release'
        ? pipelineFlat.map(({ entry, depth: d }) => (
            <RunRow key={entry.key} entry={entry} onClick={() => navigate(entry)} depth={d} />
          ))
        : node.chainedChildren?.map((c) => renderChain(c, depth + 1, navigate, actionsFor))
      }
    </Fragment>
  )
}

export function ProjectRunsTab({ projectName, jobsPaused = false }: ProjectRunsTabProps) {
  const router = useRouter()
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [pendingReleaseQueued, setPendingReleaseQueued] = useState(false)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [releaseActionState, setReleaseActionState] = useState<{ jobId: string; label: string } | null>(null)
  const [stepRetryState, setStepRetryState] = useState<{ jobId: string; label: string } | null>(null)
  const [boardActionState, setBoardActionState] = useState<{ jobId: string; label: string } | null>(null)
  const [stopState, setStopState] = useState<{ jobId: string; label: string } | null>(null)

  const stopTargetFor = (e: Entry): { jobId: string; mode: 'job' | 'release' } | null => {
    if (e.key.startsWith('vgroup:')) return null
    if (e.kind === 'release' && e.status === 'running') return { jobId: e.navJobId, mode: 'release' }
    if (e.releaseOutcome?.status === 'running') {
      return { jobId: e.releaseOutcome.releaseJobId, mode: 'release' }
    }
    if (e.status === 'running' && e.releaseId && PIPELINE_CHILD_KINDS.has(e.kind)) {
      return { jobId: e.releaseId, mode: 'release' }
    }
    if (e.status === 'running') return { jobId: e.navJobId, mode: 'job' }
    return null
  }

  const stopRun = async (e: Entry) => {
    const target = stopTargetFor(e)
    if (!target) return
    const { jobId } = target
    setStopState({ jobId, label: 'stopping' })
    try {
      const res = target.mode === 'release'
        ? await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/release/abort`, { method: 'POST' })
        : await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
      const body = await res.json().catch(() => ({})) as { status?: string; detail?: string }
      const abortPending = target.mode === 'release' && body.status === 'abort_pending'
      if (!res.ok && !abortPending) {
        throw new Error(body?.detail || `HTTP ${res.status}`)
      }
      setStopState({ jobId, label: abortPending ? 'abort pending' : 'stopped' })
      setTimeout(() => setStopState((prev) => (prev?.jobId === jobId ? null : prev)), abortPending ? 2500 : 1500)
      await loadJobs()
    } catch (error) {
      console.error('[history] stop failed', error)
      setStopState({ jobId, label: 'failed' })
      setTimeout(() => setStopState((prev) => (prev?.jobId === jobId ? null : prev)), 2500)
    }
  }
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
    const poll = async () => {
      try {
        const data = await fetchJobs(projectName, { limit: 0 })
        if (active) {
          setJobs(data.jobs)
          setPendingReleaseQueued(!!data.pendingReleaseProjects?.includes(projectName))
          setLoading(false)
        }
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [projectName])

  const entries = useMemo(() => buildEntries(jobs), [jobs])
  const groupedEntries = useMemo(() => groupReleaseChildren(entries), [entries])
  // Latest release per project — used to gate the "Continue release" /
  // "Retry release" actions so they only appear on the most recent release
  // entry. Once a newer release ran, retrying an older failed one is
  // misleading: the project state has moved on.
  const latestTopLevelReleaseKey = useMemo(() => latestReleaseKey(groupedEntries), [groupedEntries])
  const loadJobs = async () => {
    const data = await fetchJobs(projectName, { limit: 0 })
    setJobs(data.jobs)
    setPendingReleaseQueued(!!data.pendingReleaseProjects?.includes(projectName))
    setLoading(false)
    return data
  }

  // Counts reflect the flat entry list (pre-grouping) so the chip numbers
  // match what you'd see if you clicked into that filter.
  const counts = useMemo(() => {
    const c = {
      all: entries.length, running: 0, failed: 0,
      run: 0, release: 0, review: 0, test: 0, fix: 0, 'fix-ci': 0, 'fix-push': 0,
      commit: 0, push: 0, 'mark-dod': 0, 'pr-wait': 0, agent: 0, other: 0,
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const source = shouldGroup(filter) ? groupedEntries : entries
    return source.filter((e) => {
      if (!matches(e, filter)) return false
      if (!q) return true
      const hay = `${e.title} ${e.subtitle ?? ''} ${e.releaseOutcome?.label ?? ''} ${e.model ?? ''} ${e.navSessionId ?? ''} ${e.kind}`.toLowerCase()
      return hay.includes(q)
    })
  }, [entries, filter, groupedEntries, search])

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

  const thisMonthCost = useMemo(() => {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000
    return entries.reduce((sum, e) => sum + (e.startedAt >= monthStart ? e.costUsd : 0), 0)
  }, [entries])

  const navigate = (e: Entry) => {
    if (e.bucket === 'run' && e.navSessionId && e.kind !== 'release') {
      router.push(`/project/${projectName}/terminal/${e.navSessionId}`)
    } else {
      router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(e.navJobId)}`)
    }
  }

  const retryRelease = async (source: Entry) => {
    if (jobsPaused) return
    setReleaseActionState({ jobId: source.navJobId, label: 'starting' })
    try {
      const result = await releaseProject(projectName, { queueIfBlocked: true, sourceJobId: source.navJobId })
      await loadJobs()
      if (result.release_job_id) {
        setExpanded((prev) => new Set(prev).add(source.key))
      }
    } catch (error) {
      console.error('[history] release retry failed', error)
      setReleaseActionState({ jobId: source.navJobId, label: 'failed' })
      setTimeout(() => setReleaseActionState(null), 2500)
      return
    }
    setReleaseActionState(null)
  }

  const failedRetryableStep = (release: Entry): Entry | null => {
    const failed = (release.children ?? [])
      .filter((child) => child.status === 'done' && child.exitCode !== null && child.exitCode !== 0)
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    return failed?.kind === 'commit' ? failed : null
  }

  const retryPipelineStep = async (release: Entry, step: Entry) => {
    if (jobsPaused) return
    setStepRetryState({ jobId: step.navJobId, label: 'retrying' })
    try {
      if (step.kind === 'commit') {
        await pushProject(projectName, { commit: true, releaseId: release.navJobId ?? null })
      }
      await loadJobs()
      setExpanded((prev) => new Set(prev).add(release.key))
    } catch (error) {
      console.error('[history] step retry failed', error)
      setStepRetryState({ jobId: step.navJobId, label: 'failed' })
      setTimeout(() => setStepRetryState(null), 2500)
      return
    }
    setStepRetryState(null)
  }

  const releaseActionsFor = (e: Entry): React.ReactNode => {
    const outcomeStatus = e.releaseOutcome?.status
      ?? (e.kind === 'release' && (e.status === 'done' || e.status === 'aborted') && e.exitCode !== null && e.exitCode !== 0
        ? (e.children?.length ?? 0) === 0 ? 'blocked' : 'failed'
        : null)
    // Only the latest release for the project should offer continue/retry —
    // older failed releases reflect a past project state, and retrying them
    // would silently rerun on whatever's currently checked out.
    const isLatestRelease = e.kind === 'release' && e.key === latestTopLevelReleaseKey
    const isRealRelease = e.kind === 'release' && !e.key.startsWith('vgroup:')
    const retryableStep = isLatestRelease && isRealRelease ? failedRetryableStep(e) : null
    const stepRetryButton = retryableStep ? (
      (() => {
        const active = stepRetryState?.jobId === retryableStep.navJobId
        return (
          <button
            type="button"
            className="px-2 py-0.5 text-[10px] rounded border border-status-warning/40 text-status-warning bg-status-warning/10 hover:bg-status-warning/15 disabled:opacity-60 cursor-pointer"
            disabled={jobsPaused || active}
            onClick={() => retryPipelineStep(e, retryableStep)}
            title={jobsPaused
              ? 'Jobs are paused globally. Resume jobs to retry this step.'
              : 'Retry the failed commit step for this release'}
          >
            {active ? stepRetryState?.label : 'Retry commit'}
          </button>
        )
      })()
    ) : null
    const releaseButton = isLatestRelease && (outcomeStatus === 'blocked' || outcomeStatus === 'failed') ? (
      (() => {
        const active = releaseActionState?.jobId === e.navJobId
        const label = active ? releaseActionState.label : outcomeStatus === 'blocked' ? 'Retry release' : 'Continue release'
        const releaseBlocked = jobsPaused || active
        return (
          <button
            type="button"
            className="px-2 py-0.5 text-[10px] rounded border border-accent/40 text-accent bg-accent/10 hover:bg-accent/15 disabled:opacity-60 cursor-pointer"
            disabled={releaseBlocked}
            onClick={() => retryRelease(e)}
            title={jobsPaused
              ? 'Jobs are paused globally. Resume jobs to start a release.'
              : 'Start a new release attempt from the current project state'}
          >
            {label}
          </button>
        )
      })()
    ) : null
    const boardActive = boardActionState?.jobId === e.navJobId
    const canManualSyncBoard = e.status !== 'running' && !entryIsRunning(e)
    const boardButton = canManualSyncBoard ? (
      <button
        type="button"
        className="px-2 py-0.5 text-[10px] rounded border border-border text-text-secondary bg-bg-primary hover:bg-bg-tertiary disabled:opacity-60 cursor-pointer"
        disabled={boardActive}
        onClick={async () => {
          setBoardActionState({ jobId: e.navJobId, label: 'syncing' })
          try {
            await syncJobBoard(e.navJobId)
            setBoardActionState({ jobId: e.navJobId, label: 'synced' })
            setTimeout(() => setBoardActionState(null), 1500)
          } catch (error) {
            console.error('[history] board sync failed', error)
            setBoardActionState({ jobId: e.navJobId, label: 'failed' })
            setTimeout(() => setBoardActionState(null), 2500)
          }
        }}
        title="Recreate or refresh this run on the GitHub board"
      >
        {boardActive ? boardActionState?.label : 'Sync board'}
      </button>
    ) : null
    // Ordinary running jobs are cancelled through the job endpoint. Running
    // releases use the pipeline abort route so the active step is stopped and
    // the pipeline lock is finalized. Agent/run rows may look running only
    // because an attached release is still active; in that case target the
    // release, not the already-finished parent job.
    const stopTarget = stopTargetFor(e)
    const showStop = stopTarget != null
    const stopActive = stopTarget != null && stopState?.jobId === stopTarget.jobId
    const stopButton = showStop ? (
      <button
        type="button"
        className="px-2 py-0.5 text-[10px] rounded border border-status-error/40 text-status-error bg-status-error/10 hover:bg-status-error/15 disabled:opacity-60 cursor-pointer"
        disabled={stopActive}
        onClick={() => stopRun(e)}
        title="Send SIGTERM and mark this run cancelled"
      >
        {stopActive ? stopState?.label : 'Stop'}
      </button>
    ) : null
    const buttons = [stopButton, stepRetryButton, releaseButton, boardButton].filter(Boolean)
    if (buttons.length === 0) return null
    if (buttons.length === 1) return buttons[0]
    return <div className="flex items-center gap-2">{buttons}</div>
  }

  return (
    <div className="mt-4">
      {/* Release-queued banner: an agent/run finished and tried to trigger
          a release while another release was in flight (or jobs were paused)
          — the request was queued and will fire once the lock releases. */}
      {pendingReleaseQueued && (
        <Link
          href={`/pipeline?project=${encodeURIComponent(projectName)}`}
          className="mb-3 px-3 py-2 rounded-md border border-accent/30 bg-accent/5 text-xs text-accent flex items-center gap-2 hover:bg-accent/10 transition-colors"
        >
          <span className="font-mono">↦</span>
          <span>Release queued — will fire automatically when the running pipeline finishes (or jobs resume).</span>
        </Link>
      )}
      {/* Search + summary */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search prompts, models, session ids…"
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-bg-secondary border border-border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary text-xs" aria-hidden>⌕</span>
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary text-sm cursor-pointer"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <div className="text-xs text-text-tertiary font-mono whitespace-nowrap flex items-center gap-2 flex-wrap">
          <span>
            {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
            {totals.running > 0 && (
              <> · <span className="text-status-info">{totals.running} running</span></>
            )}
            {totals.tokens > 0 && <> · {formatTokens(totals.tokens)} tok</>}
            {totals.costUsd > 0 && <> · <span className="text-accent">{formatCost(totals.costUsd)}</span></>}
          </span>
          {thisMonthCost > 0 && (
            <span className="text-text-tertiary/60" title="Total cost for all runs this calendar month">
              this month: <span className="text-text-secondary">{formatCost(thisMonthCost)}</span>
            </span>
          )}
        </div>
      </div>

      {/* Unified filter row: status shortcuts + kind breakdown, one axis.
          overflow-x-auto prevents 13+ kind buttons from wrapping to multiple lines on narrow screens. */}
      <div className="flex items-center gap-1.5 overflow-x-auto mb-3 pb-0.5 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent" style={{ scrollbarWidth: 'thin' }}>
        {([
          { f: { kind: 'all' } as Filter, label: 'all', tone: 'neutral' },
          { f: { kind: 'running' } as Filter, label: 'running', tone: 'info' },
          { f: { kind: 'failed' } as Filter, label: 'failed', tone: 'error' },
        ] as const).map(({ f, label, tone }) => {
          const count = counts[f.kind] ?? 0
          if ((f.kind === 'running' || f.kind === 'failed') && count === 0 && filterKey(filter) !== filterKey(f)) return null
          const active = filterKey(filter) === filterKey(f)
          const toneCls =
            tone === 'info' ? (active ? 'border-status-info bg-status-info/15 text-status-info' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-info') :
            tone === 'error' ? (active ? 'border-status-error bg-status-error/15 text-status-error' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-error') :
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
        {(['run', 'release', 'review', 'test', 'fix', 'fix-ci', 'fix-push', 'commit', 'push', 'mark-dod', 'pr-wait', 'agent', 'other'] as const).map((b) => {
          const count = counts[b] ?? 0
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
        <div className="border border-border rounded-lg overflow-hidden bg-bg-secondary">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0" style={{ opacity: 1 - i * 0.15 }}>
              <div className="skeleton h-4 w-1 rounded-none shrink-0" />
              <div className="skeleton h-5 w-12 rounded shrink-0" />
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <div className="skeleton h-3.5 w-2/5" />
                <div className="flex items-center gap-2">
                  <div className="skeleton h-3 w-16" />
                  <div className="skeleton h-3 w-12" />
                </div>
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="skeleton h-3 w-14" />
                  <div className="skeleton h-3 w-10" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="skeleton h-4 w-16 rounded-full" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-text-secondary text-sm p-8 text-center border border-border rounded-lg bg-bg-secondary flex flex-col items-center gap-2">
          {entries.length === 0 ? (
            <>
              <span className="text-3xl opacity-30">▷</span>
              <span>No runs yet — use the Terminal tab or click 🚀 Release in the header</span>
            </>
          ) : search.trim() ? (
            <>
              <span className="text-3xl opacity-30">⌕</span>
              <span>No runs match &ldquo;{search.trim()}&rdquo;</span>
            </>
          ) : filter.kind === 'running' ? (
            <>
              <span className="text-3xl opacity-30">◎</span>
              <span>No runs currently running</span>
            </>
          ) : filter.kind === 'failed' ? (
            <>
              <span className="text-3xl opacity-30">✗</span>
              <span>No failed runs — looking good</span>
            </>
          ) : (
            <>
              <span className="text-3xl opacity-30">▤</span>
              <span>No runs match the current filter</span>
            </>
          )}
          {(search.trim() || filter.kind !== 'all') && (
            <div className="mt-2">
              <button
                className="px-3 py-1 text-xs border border-border rounded-md hover:bg-bg-tertiary cursor-pointer"
                onClick={() => { setSearch(''); setFilter({ kind: 'all' }) }}
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
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
                  // A row is expandable if it has any chainable children:
                  //   - releases with their pipeline children
                  //   - agent/run rows that own a release (release nests under agent)
                  const hasChainedKids = (e.chainedChildren?.length ?? 0) > 0
                  const isReleaseParent = e.kind === 'release' && (e.children?.length ?? 0) > 0
                  const isExpandable = isReleaseParent || hasChainedKids
                  const isExpanded = expanded.has(e.key)
                  // For an agent/run row that owns a nested release, surface that
                  // release's pipeline summary so it's visible while collapsed.
                  const ownedRelease = hasChainedKids && !isReleaseParent
                    ? e.chainedChildren?.find(c => c.kind === 'release')
                    : null
                  const rowSummary = isReleaseParent
                    ? buildReleaseSummary(e.children ?? [], e)
                    : ownedRelease
                      ? buildReleaseSummary(ownedRelease.children ?? [], ownedRelease)
                      : null
                  return (
                    <RunRow
                      key={e.key}
                      entry={e}
                      onClick={() => navigate(e)}
                      expandable={isExpandable}
                      expanded={isExpanded}
                      onToggleExpand={() => toggleExpanded(e.key)}
                      summary={rowSummary}
                      actions={releaseActionsFor(e)}
                    >
                      {isExpandable && isExpanded && (
                        <div className="bg-bg-primary/40">
                          {/* For release/vgroup rows: flatten the chain so test/review/commit/push
                              all appear at depth 1 and fix/fix-push appear at depth 2.
                              For agent/run rows that own a nested release: use renderChain
                              so the release itself shows at depth 1 with its steps below it. */}
                          {isReleaseParent
                            ? flattenPipelineSteps(
                                e.chainedChildren && e.chainedChildren.length > 0
                                  ? e.chainedChildren
                                  : (e.children ?? []).map(c => ({ ...c, chainedChildren: undefined })),
                                1
                              ).map(({ entry, depth: d }) => (
                                <RunRow key={entry.key} entry={entry} onClick={() => navigate(entry)} depth={d} />
                              ))
                            : (e.chainedChildren ?? []).map((root) => renderChain(root, 1, navigate, releaseActionsFor))
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
