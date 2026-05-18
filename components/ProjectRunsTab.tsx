'use client'

import { Fragment, useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  fetchJobs,
  releaseProject,
  pushProject,
  continueJob,
  fetchAutomationQueue,
  retryAutomationQueue,
  cancelAutomationQueueItem,
} from '@/lib/client-api'
import type { AutomationQueueItem, JobInfo } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'
import {
  formatTokens,
  formatCost,
  dayKey,
  dayLabel,
  buildEntries,
  groupReleaseChildren,
  buildReleaseSummary,
  buildReleaseProgressLabel,
  flattenReleaseChildren,
  KIND_LABEL,
  entryIsRunning,
  entryNeedsAttention,
  latestReleaseKey,
  PIPELINE_CHILD_KINDS,
  parseJobCountsResponse,
} from '@/components/project-runs/utils'
import type { Entry, JobCountsResponse, KindBucket } from '@/components/project-runs/utils'
import { RUN_ROW_GRID_CLASS, RunRow } from '@/components/project-runs/RunRow'
import { ProjectRunsEmptyState, ProjectRunsLoadingState } from '@/components/project-runs/RunStates'

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
// all appear at the same depth; fix is one level deeper.
function renderChain(
  node: Entry,
  depth: number,
  navigate: (e: Entry) => void,
  actionsFor: (e: Entry) => React.ReactNode,
): React.ReactNode {
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
      <RunRow
        entry={node}
        onClick={() => navigate(node)}
        depth={depth}
        summary={summary}
        progressLabel={progressLabel}
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

const PAGE_SIZE = 50
const MAX_REFRESH_PAGE_SIZE = 200

function mergeJobs(newer: JobInfo[], older: JobInfo[], maxRows: number): JobInfo[] {
  const byId = new Map<string, JobInfo>()
  for (const job of older) byId.set(job.id, job)
  for (const job of newer) byId.set(job.id, job)
  return Array.from(byId.values())
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, maxRows)
}

export function ProjectRunsTab({ projectName, jobsPaused = false }: ProjectRunsTabProps) {
  const router = useRouter()
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [pendingReleaseQueued, setPendingReleaseQueued] = useState(false)
  const [queueItems, setQueueItems] = useState<AutomationQueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [totalJobs, setTotalJobs] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [summary, setSummary] = useState<JobCountsResponse | null>(null)
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [releaseActionState, setReleaseActionState] = useState<{ jobId: string; label: string } | null>(null)
  const [stepRetryState, setStepRetryState] = useState<{ jobId: string; label: string } | null>(null)
  const [stopState, setStopState] = useState<{ jobId: string; label: string } | null>(null)
  const [continueState, setContinueState] = useState<{ jobId: string; label: string } | null>(null)
  const [rerunState, setRerunState] = useState<{ jobId: string; label: string } | null>(null)
  const [queueActionState, setQueueActionState] = useState<{ itemId: string; label: string } | null>(null)

  // Window after which a --resume against the source job's session is
  // unsafe — model context gets compacted and the system/skills/docs that
  // were only injected on first invocation aren't re-attached. Mirrors
  // MAX_AGE_MS in app/api/jobs/[jobId]/continue/route.ts.
  const CONTINUE_MAX_AGE_MS = 30 * 60 * 1000

  const continueTargetFor = (e: Entry): string | null => {
    if (e.status !== 'done' && e.status !== 'aborted') return null
    if (!e.navSessionId) return null
    if (!(e.kind === 'run' || e.kind.startsWith('agent:'))) return null
    if (e.finishedAt === null) return null
    if (Date.now() - e.finishedAt * 1000 > CONTINUE_MAX_AGE_MS) return null
    // Surface Continue on non-zero exits, OR on clean exits when the outcome
    // classifier flagged the run as unfinished / blocked on a clarifying
    // question (those stop without an error code but still need a prod).
    const failed = e.exitCode === null || e.exitCode !== 0
    const classifierWantsContinue =
      e.outcomeVerdict === 'needs_continue' || e.outcomeVerdict === 'asked_question'
    if (!failed && !classifierWantsContinue) return null
    return e.navJobId
  }

  const continueRun = async (e: Entry) => {
    const targetJobId = continueTargetFor(e)
    if (!targetJobId || jobsPaused) return
    setContinueState({ jobId: targetJobId, label: 'continuing' })
    try {
      await continueJob(targetJobId)
      await loadJobs()
    } catch (error) {
      console.error('[history] continue failed', error)
      setContinueState({ jobId: targetJobId, label: 'failed' })
      setTimeout(() => setContinueState((prev) => (prev?.jobId === targetJobId ? null : prev)), 2500)
      return
    }
    setContinueState(null)
  }

  const rerunTargetFor = (e: Entry): string | null => {
    if (jobsPaused || e.status === 'running' || e.key.startsWith('vgroup:')) return null
    if (!(e.bucket === 'run' || e.bucket === 'agent' || e.bucket === 'other')) return null
    return e.navJobId || null
  }

  const rerunRun = async (e: Entry) => {
    const targetJobId = rerunTargetFor(e)
    if (!targetJobId) return
    setRerunState({ jobId: targetJobId, label: 'rerunning' })
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(targetJobId)}/rerun`, { method: 'POST' })
      const body = await res.json().catch(() => ({})) as { detail?: string }
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`)
      await loadJobs()
    } catch (error) {
      console.error('[history] rerun failed', error)
      setRerunState({ jobId: targetJobId, label: 'failed' })
      setTimeout(() => setRerunState((prev) => (prev?.jobId === targetJobId ? null : prev)), 2500)
      return
    }
    setRerunState(null)
  }

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

  // Track the current window size in a ref so the polling closure can read
  // it without forcing a re-mounted interval on every state change.
  const windowSizeRef = useRef<number>(PAGE_SIZE)
  windowSizeRef.current = Math.max(PAGE_SIZE, jobs.length)

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        // Refresh only the rows already on screen so 5s polling doesn't
        // re-download the full history each tick.
        const windowSize = windowSizeRef.current
        const data = await fetchJobs(projectName, { limit: Math.min(windowSize, MAX_REFRESH_PAGE_SIZE) })
        if (active) {
          setJobs((prev) => mergeJobs(data.jobs, prev, windowSize))
          setTotalJobs(data.total ?? data.jobs.length)
          setPendingReleaseQueued(!!data.pendingReleaseProjects?.includes(projectName))
          setLoading(false)
        }
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [projectName])

  useEffect(() => {
    let active = true
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
    const loadCounts = async () => {
      try {
        const res = await fetch(`/api/jobs/counts?project=${encodeURIComponent(projectName)}`)
        if (!res.ok) return
        const data = parseJobCountsResponse(await res.json())
        if (active) setSummary(data)
      } catch {}
    }
    loadCounts()
    const interval = setInterval(loadCounts, 15000)
    return () => { active = false; clearInterval(interval) }
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
  const groupedEntries = useMemo(() => groupReleaseChildren(entries), [entries])
  // Latest release per project — used to gate the "Continue release" /
  // "Retry release" actions so they only appear on the most recent release
  // entry. Once a newer release ran, retrying an older failed one is
  // misleading: the project state has moved on.
  const latestTopLevelReleaseKey = useMemo(() => latestReleaseKey(groupedEntries), [groupedEntries])
  const loadJobs = async () => {
    const windowSize = Math.max(PAGE_SIZE, jobs.length)
    const data = await fetchJobs(projectName, { limit: Math.min(windowSize, MAX_REFRESH_PAGE_SIZE) })
    setJobs((prev) => mergeJobs(data.jobs, prev, windowSize))
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

  const retryQueuedWork = async (item: AutomationQueueItem) => {
    if (!item.retryAllowed) return
    setQueueActionState({ itemId: item.id, label: 'retrying' })
    try {
      const result = await retryAutomationQueue(item.project)
      setQueueItems(result.items)
      await loadJobs()
      setQueueActionState(null)
    } catch (error) {
      console.error('[history] queue retry failed', error)
      setQueueActionState({ itemId: item.id, label: 'failed' })
      setTimeout(() => setQueueActionState((prev) => (prev?.itemId === item.id ? null : prev)), 2500)
    }
  }

  const cancelQueuedWork = async (item: AutomationQueueItem) => {
    if (!item.cancelAllowed) return
    setQueueActionState({ itemId: item.id, label: 'cancelling' })
    try {
      await cancelAutomationQueueItem(item)
      await loadQueue()
      setQueueActionState(null)
    } catch (error) {
      console.error('[history] queue cancel failed', error)
      setQueueActionState({ itemId: item.id, label: 'failed' })
      setTimeout(() => setQueueActionState((prev) => (prev?.itemId === item.id ? null : prev)), 2500)
    }
  }

  // Counts reflect the flat entry list (pre-grouping) so the chip numbers
  // match what you'd see if you clicked into that filter.
  const counts = useMemo(() => {
    const c = {
      all: entries.length, running: 0, failed: 0,
      run: 0, release: 0, review: 0, test: 0, fix: 0, 'fix-ci': 0,
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
          <Button
            type="button"
            variant="warning"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={jobsPaused || active}
            onClick={() => retryPipelineStep(e, retryableStep)}
            title={jobsPaused
              ? 'Jobs are paused globally. Resume jobs to retry this step.'
              : 'Retry the failed commit step for this release'}
          >
            {active ? stepRetryState?.label : 'Retry commit'}
          </Button>
        )
      })()
    ) : null
    const releaseButton = isLatestRelease && (outcomeStatus === 'blocked' || outcomeStatus === 'failed') ? (
      (() => {
        const active = releaseActionState?.jobId === e.navJobId
        const label = active ? releaseActionState.label : outcomeStatus === 'blocked' ? 'Retry release' : 'Continue release'
        const releaseBlocked = jobsPaused || active
        return (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={releaseBlocked}
            onClick={() => retryRelease(e)}
            title={jobsPaused
              ? 'Jobs are paused globally. Resume jobs to start a release.'
              : 'Start a new release attempt from the current project state'}
          >
            {label}
          </Button>
        )
      })()
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
      <Button
        type="button"
        variant="danger"
        size="sm"
        className="h-7 px-2 text-[11px]"
        disabled={stopActive}
        onClick={() => stopRun(e)}
        title="Send SIGTERM and mark this run cancelled"
      >
        {stopActive ? stopState?.label : 'Stop'}
      </Button>
    ) : null
    const continueTargetJobId = continueTargetFor(e)
    const continueButton = continueTargetJobId ? (
      (() => {
        const active = continueState?.jobId === continueTargetJobId
        return (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={jobsPaused || active}
            onClick={() => continueRun(e)}
            title={jobsPaused
              ? 'Jobs are paused globally. Resume jobs to continue this run.'
              : 'Resume the previous CLI session and prod the agent to keep going'}
          >
            {active ? continueState?.label : 'Continue'}
          </Button>
        )
      })()
    ) : null
    const rerunTargetJobId = rerunTargetFor(e)
    const rerunButton = rerunTargetJobId ? (
      (() => {
        const active = rerunState?.jobId === rerunTargetJobId
        return (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={active}
            onClick={() => rerunRun(e)}
            title={jobsPaused ? 'Jobs are paused globally. Resume jobs to rerun this entry.' : 'Start a new run from this entry’s saved prompt'}
          >
            {active ? rerunState?.label : 'Rerun'}
          </Button>
        )
      })()
    ) : null
    const buttons = [stopButton, continueButton, rerunButton, stepRetryButton, releaseButton].filter(Boolean)
    if (buttons.length === 0) return null
    if (buttons.length === 1) return buttons[0]
    return <div className="flex flex-wrap items-center justify-end gap-1.5">{buttons}</div>
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
      {queueItems.length > 0 && (
        <div className="mb-3 rounded-lg border border-status-warning/30 bg-status-warning/5">
          <div className="flex items-center justify-between gap-3 border-b border-status-warning/20 px-3 py-2">
            <div>
              <div className="text-xs font-medium text-text-primary">Queued automation</div>
              <div className="text-[11px] text-text-tertiary">Retry or cancel deferred releases and agent runs for this project.</div>
            </div>
            <Link
              href={`/pipeline?project=${encodeURIComponent(projectName)}`}
              className="text-[11px] text-accent hover:text-accent-hover"
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
        </div>
      )}
      {/* Search + summary */}
      <div className="mb-3 rounded-lg border border-border bg-bg-secondary">
        <div className="grid gap-3 border-b border-border p-3 lg:grid-cols-[minmax(280px,1fr)_auto] lg:items-start">
        <div>
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search prompts, models, session ids…"
              className="w-full pl-8 pr-8 py-1.5 text-sm bg-bg-primary border border-border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
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
          <div className="mt-2 flex items-center gap-2 text-[11px] text-text-tertiary">
            <span className="font-mono">
              showing {filtered.length} of {summary?.total ?? (totalJobs || entries.length)}
            </span>
            {(summary?.byStatus.running ?? loadedTotals.running) > 0 && (
              <span className="font-mono text-status-info">
                {summary?.byStatus.running ?? loadedTotals.running} running
              </span>
            )}
            {(search.trim() || filter.kind !== 'all') && (
              <button
                type="button"
                className="font-mono text-accent hover:text-accent-hover cursor-pointer"
                onClick={() => { setSearch(''); setFilter({ kind: 'all' }) }}
              >
                clear filters
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[520px]">
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary">entries</div>
            <div className="mt-0.5 font-mono text-base font-semibold text-text-primary tabular-nums">{summary?.total ?? entries.length}</div>
          </div>
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary">running</div>
            <div className="mt-0.5 font-mono text-base font-semibold text-status-info tabular-nums">{summary?.byStatus.running ?? loadedTotals.running}</div>
          </div>
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary">tokens</div>
            <div className="mt-0.5 font-mono text-base font-semibold text-text-primary tabular-nums">{formatTokens(summary?.tokens.total ?? loadedTotals.tokens)}</div>
          </div>
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2" title="Total cost for all runs this calendar month">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary">month cost</div>
            <div className="mt-0.5 font-mono text-base font-semibold text-accent tabular-nums">{formatCost(thisMonthCost)}</div>
          </div>
        </div>
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto p-1 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent" style={{ scrollbarWidth: 'thin' }}>
          {([
            { f: { kind: 'all' } as Filter, label: 'all', tone: 'neutral' },
            { f: { kind: 'running' } as Filter, label: 'running', tone: 'info' },
            { f: { kind: 'failed' } as Filter, label: 'failed', tone: 'error' },
          ] as const).map(({ f, label, tone }) => {
            const count = counts[f.kind] ?? 0
            if ((f.kind === 'running' || f.kind === 'failed') && count === 0 && filterKey(filter) !== filterKey(f)) return null
            const active = filterKey(filter) === filterKey(f)
            const toneCls =
              tone === 'info' ? (active ? 'border-status-info bg-status-info/15 text-status-info' : 'border-transparent text-text-secondary hover:text-status-info hover:bg-bg-primary') :
              tone === 'error' ? (active ? 'border-status-error bg-status-error/15 text-status-error' : 'border-transparent text-text-secondary hover:text-status-error hover:bg-bg-primary') :
              (active ? 'border-accent bg-accent/15 text-accent' : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-primary')
            return (
              <button
                key={label}
                className={`shrink-0 px-2.5 py-1 text-xs rounded-md font-mono cursor-pointer border ${toneCls}`}
                onClick={() => setFilter(f)}
              >
                {label} <span className="opacity-70">{count}</span>
              </button>
            )
          })}
          <span className="shrink-0 h-5 w-px bg-border mx-1" aria-hidden />
          {(['run', 'release', 'review', 'test', 'fix', 'fix-ci', 'commit', 'push', 'mark-dod', 'pr-wait', 'agent', 'other'] as const).map((b) => {
            const count = counts[b] ?? 0
            const active = filter.kind === 'bucket' && filter.bucket === b
            if (count === 0 && !active) return null
            return (
              <button
                key={b}
                className={`shrink-0 px-2.5 py-1 text-xs rounded-md font-mono cursor-pointer border ${
                  active
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-primary'
                }`}
                onClick={() => setFilter({ kind: 'bucket', bucket: b })}
              >
                {KIND_LABEL[b]} <span className="opacity-70">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

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
              <div className={`border border-border rounded-lg overflow-hidden bg-bg-primary lg:grid ${RUN_ROW_GRID_CLASS} lg:gap-x-3`}>
                <div className="hidden border-b border-border bg-bg-secondary pl-4 pr-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-tertiary lg:col-span-full lg:grid lg:grid-cols-subgrid lg:gap-x-3">
                  <span>wanted</span>
                  <span>done / progress</span>
                  <span className="text-right">duration</span>
                  <span className="text-right">usage</span>
                  <span className="text-right">actions</span>
                </div>
                {g.items.map((e) => {
                  // A row is expandable if it has any chainable children:
                  //   - releases with their pipeline children
                  //   - agent/run rows that own a release (release nests under agent)
                  const hasChainedKids = (e.chainedChildren?.length ?? 0) > 0
                  const hasTurnBreakdown = (e.turnEntries?.length ?? 0) > 1
                  const isReleaseParent = e.kind === 'release' && (e.children?.length ?? 0) > 0
                  const isExpandable = isReleaseParent || hasChainedKids || hasTurnBreakdown
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
                  const rowProgressLabel = isReleaseParent
                    ? buildReleaseProgressLabel(e.children ?? [], e)
                    : ownedRelease
                      ? buildReleaseProgressLabel(ownedRelease.children ?? [], ownedRelease)
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
                      progressLabel={rowProgressLabel}
                      actions={releaseActionsFor(e)}
                    >
                      {isExpandable && isExpanded && (
                        <div className="bg-bg-primary/40 lg:col-span-full lg:grid lg:grid-cols-subgrid lg:gap-x-3">
                          {/* For release/vgroup rows: flatten the chain so test/review/commit/push
                              all appear at depth 1 and fix appears at depth 2.
                              For agent/run rows that own a nested release: use renderChain
                              so the release itself shows at depth 1 with its steps below it. */}
                          {isReleaseParent
                            ? flattenReleaseChildren(e.children ?? [], 1).map(({ entry, depth: d }) => (
                                <RunRow key={entry.key} entry={entry} onClick={() => navigate(entry)} depth={d} />
                              ))
                            : (
                              <>
                                {(e.chainedChildren ?? []).map((root) => renderChain(root, 1, navigate, releaseActionsFor))}
                                {/* Per-turn cost breakdown for multi-turn chat/agent rows.
                                    Sorted newest-first to match parent ordering. */}
                                {hasTurnBreakdown && [...e.turnEntries!]
                                  .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
                                  .map((turn) => (
                                    <RunRow key={turn.key} entry={turn} onClick={() => navigate(turn)} depth={1} />
                                  ))}
                              </>
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
          {hasMore && (
            <div className="flex justify-center py-3">
              <Button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                variant="secondary"
                size="md"
              >
                {loadingMore ? 'Loading…' : `Load older (${totalJobs - jobs.length} remaining)`}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
