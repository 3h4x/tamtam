'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { reviewProject, fetchAgents } from '@/lib/client-api'
import type { Agent } from '@/lib/client-api'

interface ProjectRuntimeEntry {
  hasRunningReview: boolean
  hasRunningTest: boolean
  hasRunningRelease: boolean
  hasRunningPipelineChild: boolean
  runningCount: number
  runningKinds: string[]
  runningAgentNames: string[]
  latestVerdict: string | null
  latestVerdictAt: number | null
  lastActivityAt: number | null
  lastJob: {
    id: string
    kind: string
    status: 'running' | 'done' | 'aborted'
    exitCode: number | null
    startedAt: number
    finishedAt: number | null
    verdict: string | null
  } | null
}
import type { FleetHealth } from '@/hooks/useProjectHealth'
import { formatAgo } from '@/lib/shared/format'
import { getAggregateCi, getCiFailedUrl } from '@/lib/shared/statusConstants'
import { LoadingState } from '@/components/LoadingState'
import { ProjectLogo } from '@/components/ProjectLogo'
import { useToast } from '@/components/Toast'
import { subscribeToSettingsChanged } from '@/lib/shared/settings-events'

type SortKey = 'project' | 'status' | 'changes' | 'last_run' | 'next_run' | 'ci'
type SortDir = 'asc' | 'desc'

const PROJECT_SORT_KEY_STORAGE = 'tamtam.projects.sortKey'
const PROJECT_SORT_DIR_STORAGE = 'tamtam.projects.sortDir'
const sortKeys = new Set<SortKey>(['project', 'status', 'changes', 'last_run', 'next_run', 'ci'])

function getProjectSortStorage(): Storage | null {
  if (typeof window === 'undefined') return null

  try {
    const storage = window.localStorage
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null
    return storage
  } catch {
    return null
  }
}

function readProjectSortSetting(key: string): string | null {
  try {
    return getProjectSortStorage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeProjectSortSetting(key: string, value: string) {
  try {
    getProjectSortStorage()?.setItem(key, value)
  } catch {
    // Sorting still works without persistence when storage is unavailable.
  }
}

interface SchedulerEntry {
  agentId: string
  project: string
  name: string
  schedule: string
  enabled: boolean
  nextFireMs: number
  lastFireMs: number | null
}

interface QuotaWindow {
  utilization: number
  resetsAt: string | null
  msUntilReset: number | null
}

interface QuotaSnapshot {
  sevenDay: QuotaWindow
  gateEnabled?: boolean
  schedulerThrottle?: {
    reason: string
    projectedPct: number
    worstProvider: string
    resumesAtMs: number | null
  } | null
}

function formatNextFire(ms: number): { text: string; tone: 'overdue' | 'imminent' | 'normal' | 'far' } {
  const now = Date.now()
  const delta = ms - now
  if (delta <= -30_000) {
    const sec = Math.round(-delta / 1000)
    if (sec < 60) return { text: `${sec}s overdue`, tone: 'overdue' }
    const min = Math.round(sec / 60)
    if (min < 60) return { text: `${min}m overdue`, tone: 'overdue' }
    return { text: 'overdue', tone: 'overdue' }
  }
  if (delta <= 30_000) return { text: 'now', tone: 'imminent' }
  const sec = Math.round(delta / 1000)
  if (sec < 60) return { text: `in ${sec}s`, tone: 'imminent' }
  const min = Math.round(sec / 60)
  if (min < 5) return { text: `in ${min}m`, tone: 'imminent' }
  if (min < 60) return { text: `in ${min}m`, tone: 'normal' }
  const hr = Math.round(min / 60)
  if (hr < 24) return { text: `in ${hr}h`, tone: 'normal' }
  const d = Math.round(hr / 24)
  return { text: `in ${d}d`, tone: 'far' }
}

interface ProjectTablePageProps {
  fleet: FleetHealth
  issueCounts?: Record<string, { prs: number; issues: number }>
  loading?: boolean
}

function StatusDot({ ok }: { ok: boolean }) {
  return ok ? (
    <svg className="w-3.5 h-3.5 text-status-success shrink-0" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M4.5 7l1.8 1.8 3-3.5" />
    </svg>
  ) : (
    <svg className="w-3.5 h-3.5 text-status-error shrink-0" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M5 5l4 4M9 5l-4 4" />
    </svg>
  )
}

function WarningDot() {
  return (
    <svg className="w-3.5 h-3.5 text-status-warning shrink-0" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 1.5L12.5 12H1.5L7 1.5z" />
      <path d="M7 5.5v3M7 10v.5" strokeLinecap="round" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-accent animate-spin shrink-0" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M7 1.5a5.5 5.5 0 1 1-3.889 1.611" />
    </svg>
  )
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return (
      <svg className="w-3 h-3 opacity-30 shrink-0" viewBox="0 0 12 12" fill="currentColor">
        <path d="M6 2l3 4H3l3-4zM6 10L3 6h6l-3 4z" />
      </svg>
    )
  }
  return dir === 'asc' ? (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill="currentColor">
      <path d="M6 2l3 4H3l3-4z" />
    </svg>
  ) : (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill="currentColor">
      <path d="M6 10L3 6h6l-3 4z" />
    </svg>
  )
}

function AgentPills({
  agents,
  runningNames,
  schedulerEntries,
}: {
  agents: Agent[]
  runningNames: Set<string>
  schedulerEntries: SchedulerEntry[]
}) {
  if (agents.length === 0) return <span className="text-text-tertiary">—</span>

  const MAX_VISIBLE = 4
  const visible = agents.slice(0, MAX_VISIBLE)
  const overflow = agents.length - MAX_VISIBLE

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((agent) => {
        const isRunning = runningNames.has(agent.name)
        const sched = schedulerEntries.find(e => e.name === agent.name)
        let tooltipParts: string[] = []
        if (agent.schedule) tooltipParts.push(`schedule: ${agent.schedule}`)
        if (sched) {
          const now = Date.now()
          const delta = sched.nextFireMs - now
          if (delta > 0) {
            const min = Math.round(delta / 60000)
            tooltipParts.push(min < 60 ? `next in ${min}m` : `next in ${Math.round(min / 60)}h`)
          } else if (delta > -30000) {
            tooltipParts.push('next: now')
          }
          if (sched.lastFireMs) {
            const agoMin = Math.round((now - sched.lastFireMs) / 60000)
            tooltipParts.push(agoMin < 60 ? `last ${agoMin}m ago` : `last ${Math.round(agoMin / 60)}h ago`)
          } else {
            tooltipParts.push('never fired')
          }
        } else if (!agent.schedule) {
          tooltipParts.push('on-demand')
        }
        return (
          <span
            key={agent.id}
            title={tooltipParts.join(' · ')}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-colors ${
              isRunning
                ? 'bg-accent/15 text-accent border border-accent/30'
                : 'bg-bg-tertiary text-text-secondary border border-transparent'
            }`}
          >
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />}
            {agent.name}
          </span>
        )
      })}
      {overflow > 0 && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs text-text-tertiary bg-bg-tertiary">
          +{overflow}
        </span>
      )}
    </div>
  )
}

const healthOrder: Record<string, number> = { error: 0, warning: 1, unknown: 2, healthy: 3 }
const ciOrder: Record<string, number> = { failure: 0, in_progress: 1, success: 2 }

export function ProjectTablePage({ fleet, issueCounts = {}, loading = false }: ProjectTablePageProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [runtime, setRuntime] = useState<Record<string, ProjectRuntimeEntry>>({})
  const [agentsByProject, setAgentsByProject] = useState<Record<string, Agent[]>>({})
  const [schedulerByProject, setSchedulerByProject] = useState<Record<string, SchedulerEntry[]>>({})
  const [schedulerPaused, setSchedulerPaused] = useState(false)
  const [budgetGateEnabled, setBudgetGateEnabled] = useState(false)
  const [scheduledThrottlePaused, setScheduledThrottlePaused] = useState(false)
  const [quotaRefreshSeq, setQuotaRefreshSeq] = useState(0)
  const [sortKey, setSortKey] = useState<SortKey>('project')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [sortReady, setSortReady] = useState(false)

  useEffect(() => {
    const savedKey = readProjectSortSetting(PROJECT_SORT_KEY_STORAGE)
    const savedDir = readProjectSortSetting(PROJECT_SORT_DIR_STORAGE)

    if (savedKey && sortKeys.has(savedKey as SortKey)) {
      setSortKey(savedKey as SortKey)
    }
    if (savedDir === 'asc' || savedDir === 'desc') {
      setSortDir(savedDir)
    }

    setSortReady(true)
  }, [])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const r = await fetch('/api/agents/scheduler-health')
        if (!r.ok) return
        const data = await r.json()
        if (!active) return
        const grouped: Record<string, SchedulerEntry[]> = {}
        for (const e of (data.internal?.entries ?? []) as SchedulerEntry[]) {
          if (!grouped[e.project]) grouped[e.project] = []
          grouped[e.project].push(e)
        }
        setSchedulerByProject(grouped)
        setSchedulerPaused(!!data.internal?.paused)
      } catch { /* ignore */ }
    }
    load()
    // Poll scheduler health every 45s (was 15s). Reduced frequency to cut server load;
    // next-fire predictions may be stale for up to 45s, but this is acceptable since
    // scheduler state changes infrequently.
    const interval = setInterval(load, 45000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  useEffect(() => {
    let active = true
    const applySettings = (
      settings: Record<string, string | undefined>,
      { merge }: { merge: boolean },
    ) => {
      if (merge && !('budget_block_runs_enabled' in settings)) return
      const enabled = settings.budget_block_runs_enabled === 'true'
      setBudgetGateEnabled(enabled)
      if (!enabled) setScheduledThrottlePaused(false)
    }
    const loadSettings = async () => {
      try {
        const response = await fetch('/api/settings')
        if (!response.ok) return
        const data = await response.json()
        if (!active) return
        applySettings(data.settings ?? {}, { merge: false })
      } catch {
        if (active) applySettings({}, { merge: false })
      }
    }
    const unsubscribe = subscribeToSettingsChanged((settings) => {
      if (!active) return
      applySettings(settings, { merge: true })
      setQuotaRefreshSeq((seq) => seq + 1)
    })
    void loadSettings()
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let active = true
    let interval: ReturnType<typeof setInterval> | null = null
    if (!budgetGateEnabled) {
      setScheduledThrottlePaused(false)
      return () => {
        active = false
      }
    }
    const load = async () => {
      try {
        const r = await fetch('/api/usage/quota')
        if (!r.ok) return
        const data = (await r.json()) as QuotaSnapshot
        if (!active) return
        setScheduledThrottlePaused(budgetGateEnabled && !!data.gateEnabled && data.schedulerThrottle != null)
      } catch {
        if (active) setScheduledThrottlePaused(false)
      }
    }
    void load()
    interval = setInterval(load, 300000)
    return () => {
      active = false
      if (interval) clearInterval(interval)
    }
  }, [budgetGateEnabled, quotaRefreshSeq])

  useEffect(() => {
    if (!sortReady) return
    writeProjectSortSetting(PROJECT_SORT_KEY_STORAGE, sortKey)
  }, [sortKey, sortReady])

  useEffect(() => {
    if (!sortReady) return
    writeProjectSortSetting(PROJECT_SORT_DIR_STORAGE, sortDir)
  }, [sortDir, sortReady])

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const res = await fetch('/api/projects/runtime')
        if (!res.ok) return
        const data = await res.json() as { projects: Record<string, ProjectRuntimeEntry> }
        if (active) setRuntime(data.projects ?? {})
      } catch { /* ignore */ }
    }
    poll()
    // Poll runtime snapshot every 30s — fast enough for "is anything running"
    // indicators and slow enough to be cheap. The endpoint ships one row per
    // project, not a job dump.
    const interval = setInterval(poll, 30000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const data = await fetchAgents(undefined, { fields: 'summary' })
        if (!active) return
        const grouped: Record<string, Agent[]> = {}
        for (const agent of data.agents) {
          if (!grouped[agent.project]) grouped[agent.project] = []
          grouped[agent.project].push(agent)
        }
        setAgentsByProject(grouped)
      } catch { /* ignore */ }
    }
    load()
    // Poll agents every 30s (was 10s). Reduced frequency to cut server load; agent
    // list changes (enable/disable, new agents) may be stale for up to 30s, but
    // this is acceptable since agent configuration changes infrequently.
    const interval = setInterval(load, 30000)
    return () => { active = false; clearInterval(interval) }
  }, [])

const isReviewRunning = (projectName: string) => !!runtime[projectName]?.hasRunningReview

  const getLatestVerdict = (projectName: string) => runtime[projectName]?.latestVerdict ?? undefined

  const getRunningAgentNames = (projectName: string): Set<string> =>
    new Set(runtime[projectName]?.runningAgentNames ?? [])

  const getRecentTs = (name: string) => runtime[name]?.lastActivityAt ?? 0

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir(key === 'project' ? 'asc' : 'desc')
    }
  }

  const handleReview = async (e: React.MouseEvent, projectName: string) => {
    e.stopPropagation()
    if (isReviewRunning(projectName)) return
    try {
      await reviewProject(projectName)
      toast(`Review started for ${projectName}`, 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : `Failed to start review for ${projectName}`, 'error')
    }
  }

  const getNextFire = (projectName: string): { ms: number; agent: string } | null => {
    const entries = (schedulerByProject[projectName] ?? []).filter(e => e.enabled && e.nextFireMs > 0)
    if (entries.length === 0) return null
    const soonest = entries.reduce((min, e) => e.nextFireMs < min.nextFireMs ? e : min)
    return { ms: soonest.nextFireMs, agent: soonest.name }
  }

  const sortedProjects = [...fleet.projects].sort((a, b) => {
    let cmp = 0
    switch (sortKey) {
      case 'project':
        cmp = a.project.localeCompare(b.project)
        break
      case 'status':
        cmp = (healthOrder[a.status] ?? 99) - (healthOrder[b.status] ?? 99)
        break
      case 'changes':
        cmp = a.totalChanges - b.totalChanges
        break
      case 'last_run':
        cmp = getRecentTs(a.project) - getRecentTs(b.project)
        break
      case 'next_run': {
        const paused = schedulerPaused || scheduledThrottlePaused
        const na = paused ? Number.POSITIVE_INFINITY : getNextFire(a.project)?.ms ?? Number.POSITIVE_INFINITY
        const nb = paused ? Number.POSITIVE_INFINITY : getNextFire(b.project)?.ms ?? Number.POSITIVE_INFINITY
        cmp = na - nb
        break
      }
      case 'ci': {
        const ca = getAggregateCi(a)
        const cb = getAggregateCi(b)
        cmp = (ciOrder[ca ?? ''] ?? 99) - (ciOrder[cb ?? ''] ?? 99)
        break
      }
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const thClass = (key: SortKey) =>
    `px-4 py-2.5 font-medium cursor-pointer select-none hover:text-text-secondary transition-colors ${sortKey === key ? 'text-text-secondary' : ''}`

  if (!sortReady) return <LoadingState />

  const showLoadingOverlay = loading

  return (
    <div className="relative overflow-x-auto" aria-busy={showLoadingOverlay}>
      {showLoadingOverlay && (
        <div className="absolute inset-0 z-10 bg-bg-primary">
          <div className="pointer-events-none">
            <div className="px-4 py-3">
              <div className="skeleton h-7 w-32" />
            </div>
            <div className="border-t border-border">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-4 px-4 py-4 border-b border-border last:border-0"
                  style={{ opacity: 1 - i * 0.12 }}
                >
                  <div className="flex items-center gap-3">
                    <div className="skeleton h-4 w-4 rounded-full" />
                    <div className="skeleton h-4 w-36" />
                  </div>
                  <div className="skeleton h-5 w-20 rounded-full" />
                  <div className="skeleton h-4 w-12" />
                  <div className="skeleton h-4 w-8" />
                  <div className="skeleton h-5 w-20 rounded-full" />
                  <div className="skeleton h-4 w-10" />
                  <div className="skeleton h-4 w-8" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-xs text-text-tertiary uppercase tracking-wider border-b border-border">
            <th className={thClass('project')} onClick={() => handleSort('project')}>
              <span className="flex items-center gap-1">Project <SortIcon active={sortKey === 'project'} dir={sortDir} /></span>
            </th>
            <th className="px-4 py-2.5 font-medium">Agents</th>
            <th className={thClass('status')} onClick={() => handleSort('status')}>
              <span className="flex items-center gap-1">Status <SortIcon active={sortKey === 'status'} dir={sortDir} /></span>
            </th>
            <th className={thClass('changes')} onClick={() => handleSort('changes')}>
              <span className="flex items-center gap-1">Changes <SortIcon active={sortKey === 'changes'} dir={sortDir} /></span>
            </th>
            <th className={thClass('last_run')} onClick={() => handleSort('last_run')}>
              <span className="flex items-center gap-1">Last Run <SortIcon active={sortKey === 'last_run'} dir={sortDir} /></span>
            </th>
            <th className={thClass('next_run')} onClick={() => handleSort('next_run')}>
              <span className="flex items-center gap-1">Next Run <SortIcon active={sortKey === 'next_run'} dir={sortDir} /></span>
            </th>
            <th className={thClass('ci')} onClick={() => handleSort('ci')}>
              <span className="flex items-center gap-1">CI <SortIcon active={sortKey === 'ci'} dir={sortDir} /></span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedProjects.map((project) => {
            const ci = getAggregateCi(project)
            const ciUrl = getCiFailedUrl(project)
            const hasUnreviewed = project.unreviewedCount > 0
            const reviewing = isReviewRunning(project.project)
            const verdict = getLatestVerdict(project.project)

            const projectRuntime = runtime[project.project]
            const runningCount = projectRuntime?.runningCount ?? 0
            const runningKinds = projectRuntime?.runningKinds ?? []
            const lastJob = projectRuntime?.lastJob ?? null

            const agents = agentsByProject[project.project] || []
            const runningAgentNames = getRunningAgentNames(project.project)

            // show warning in STATUS only for non-unreviewed reasons (paused, out-of-sync, stale)
            const showWarning = project.status === 'warning' && !hasUnreviewed

            const scheduledCount = (schedulerByProject[project.project] ?? []).filter(e => e.enabled).length
            const projectPaused = project.tasks.some(th => th.task.paused)
            const outOfSync = project.tasks.some(th => th.task.sync === false)
            const nextFire = getNextFire(project.project)
            const schedulesPaused = schedulerPaused || scheduledThrottlePaused

            return (
              <tr
                key={project.project}
                className="border-b border-border/50 hover:bg-bg-secondary/40 cursor-pointer transition-colors"
                onClick={() => router.push(`/project/${project.project}`)}
              >
                {/* Project */}
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <ProjectLogo projectName={project.project} size={20} />
                    <span className="font-medium text-text-primary" data-private>{project.project}</span>
                    {issueCounts[project.project]?.prs > 0 && (
                      <span
                        title={`${issueCounts[project.project].prs} open PR${issueCounts[project.project].prs !== 1 ? 's' : ''}`}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-accent/15 text-accent border border-accent/30"
                      >
                        <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                        </svg>
                        {issueCounts[project.project].prs}
                      </span>
                    )}
                    {issueCounts[project.project]?.issues > 0 && (
                      <span
                        title={`${issueCounts[project.project].issues} open issue${issueCounts[project.project].issues !== 1 ? 's' : ''}`}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-bg-tertiary text-text-secondary border border-border"
                      >
                        <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
                          <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
                        </svg>
                        {issueCounts[project.project].issues}
                      </span>
                    )}
                  </span>
                </td>

                {/* Agents */}
                <td className="px-4 py-2 max-w-[280px]" onClick={e => e.stopPropagation()}>
                  <AgentPills agents={agents} runningNames={runningAgentNames} schedulerEntries={schedulerByProject[project.project] ?? []} />
                </td>

                {/* Status */}
                <td className="px-4 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {runningCount > 0 && (
                      <span title={runningKinds.join(', ')} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-accent/15 text-accent border border-accent/30">
                        <SpinnerIcon />
                        {runningCount > 1 ? `${runningCount} running` : 'running'}
                      </span>
                    )}
                    {project.status === 'error' && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-status-error/10 text-status-error border border-status-error/30">
                        <StatusDot ok={false} />
                        error
                      </span>
                    )}
                    {schedulesPaused ? (
                      <span
                        title={schedulerPaused ? 'Internal scheduler paused (Resume jobs in header)' : 'Scheduled agents paused by weekly budget'}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-status-warning/10 text-status-warning border border-status-warning/30"
                      >
                        ⏸ scheduled paused
                      </span>
                    ) : projectPaused && (
                      <span title="Project schedule paused" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-status-warning/10 text-status-warning border border-status-warning/30">
                        ⏸ scheduled paused
                      </span>
                    )}
                    {outOfSync && (
                      <span title="Schedule out of sync with config" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-status-warning/10 text-status-warning border border-status-warning/30">
                        <WarningDot />
                        out of sync
                      </span>
                    )}
                    {showWarning && !projectPaused && !outOfSync && !schedulesPaused && (
                      <span title="Project flagged with a warning (e.g. stale data)" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-status-warning/10 text-status-warning border border-status-warning/30">
                        <WarningDot />
                        warning
                      </span>
                    )}
                    {scheduledCount > 0 && !schedulesPaused && (
                      <span title={`${scheduledCount} scheduled agent${scheduledCount !== 1 ? 's' : ''}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-bg-tertiary text-text-secondary border border-border">
                        <svg className="w-3 h-3 shrink-0" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="7" cy="7" r="5.5" />
                          <path d="M7 4v3l2 1.5" />
                        </svg>
                        {scheduledCount} scheduled
                      </span>
                    )}
                    {runningCount === 0 && project.status !== 'error' && !showWarning && scheduledCount === 0 && lastJob && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium text-text-tertiary">
                        <StatusDot ok={true} />
                        idle
                      </span>
                    )}
                    {runningCount === 0 && project.status !== 'error' && !showWarning && scheduledCount === 0 && !lastJob && (
                      <span className="text-text-tertiary text-xs">—</span>
                    )}
                  </div>
                </td>

                {/* Changes */}
                <td className="px-4 py-2" onClick={e => e.stopPropagation()}>
                  {project.totalChanges > 0 ? (
                    <span className="flex items-center gap-2">
                      <span className={`text-sm font-medium tabular-nums ${hasUnreviewed ? 'text-status-warning' : 'text-text-primary'}`}>
                        {project.totalChanges}
                      </span>
                      {hasUnreviewed ? (
                        <button
                          className="px-2 py-0.5 text-xs border border-border rounded bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                          onClick={e => handleReview(e, project.project)}
                          disabled={reviewing}
                        >
                          {reviewing ? 'reviewing…' : 'review'}
                        </button>
                      ) : verdict ? (
                        <span className={`text-xs font-medium ${
                          verdict === 'LGTM' ? 'text-status-success' :
                          verdict === 'NEEDS ATTENTION' ? 'text-status-warning' :
                          'text-status-error'
                        }`}>
                          {verdict === 'LGTM' ? 'lgtm' : verdict === 'NEEDS ATTENTION' ? 'needs attention' : 'do not ship'}
                        </span>
                      ) : (
                        <StatusDot ok={true} />
                      )}
                    </span>
                  ) : project.unpushed > 0 ? (
                    <span className="text-sm text-status-warning">↑{project.unpushed}</span>
                  ) : (
                    <span className="text-text-tertiary text-sm">—</span>
                  )}
                </td>

                {/* Last Run */}
                <td className="px-4 py-2">
                  {lastJob ? (
                    <span className="flex items-center gap-1.5 flex-wrap">
                      {lastJob.status === 'running' ? (
                        <SpinnerIcon />
                      ) : (
                        <StatusDot ok={lastJob.exitCode === 0} />
                      )}
                      <span className="text-xs text-text-secondary font-medium">{lastJob.kind.startsWith('agent:') ? lastJob.kind.slice(6) : lastJob.kind}</span>
                      <span className="text-xs text-text-tertiary">
                        {lastJob.status === 'running'
                          ? `running · started ${formatAgo(lastJob.startedAt)}`
                          : formatAgo(lastJob.finishedAt ?? lastJob.startedAt)}
                      </span>
                      {lastJob.verdict && lastJob.status !== 'running' && (
                        <span className={`text-[10px] px-1 py-0.5 rounded font-mono font-medium ${
                          lastJob.verdict === 'LGTM' ? 'bg-status-success/15 text-status-success' :
                          lastJob.verdict === 'DO NOT SHIP' ? 'bg-status-error/15 text-status-error' :
                          'bg-status-warning/15 text-status-warning'
                        }`}>
                          {lastJob.verdict === 'LGTM' ? 'lgtm' : lastJob.verdict === 'DO NOT SHIP' ? 'dns' : 'attn'}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-text-tertiary text-sm">—</span>
                  )}
                </td>

                {/* Next Run */}
                <td className="px-4 py-2 text-sm">
                  {schedulesPaused && scheduledCount > 0 ? (
                    <span title={schedulerPaused ? 'Internal scheduler paused' : 'Scheduled agents paused by weekly budget'} className="text-status-warning font-medium">
                      scheduled paused
                    </span>
                  ) : nextFire ? (() => {
                    const f = formatNextFire(nextFire.ms)
                    const toneClass =
                      f.tone === 'overdue' ? 'text-status-error font-medium' :
                      f.tone === 'imminent' ? 'text-status-warning font-medium' :
                      f.tone === 'far' ? 'text-text-tertiary' :
                      'text-text-secondary'
                    return (
                      <span title={`${nextFire.agent} · ${new Date(nextFire.ms).toLocaleString()}`} className={`tabular-nums ${toneClass}`}>
                        {f.text}
                      </span>
                    )
                  })() : (
                    <span className="text-text-tertiary">—</span>
                  )}
                </td>

                {/* CI */}
                <td className="px-4 py-2" onClick={e => e.stopPropagation()}>
                  {ci === 'success' && <StatusDot ok={true} />}
                  {ci === 'failure' && (
                    ciUrl ? (
                      <a href={ciUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                        <StatusDot ok={false} />
                      </a>
                    ) : (
                      <StatusDot ok={false} />
                    )
                  )}
                  {ci === 'in_progress' && <SpinnerIcon />}
                  {ci === null && <span className="text-text-tertiary text-sm">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
