'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { reviewProject, releaseProject, fetchJobs, fetchAgents } from '@/lib/client-api'
import type { JobInfo, Agent } from '@/lib/client-api'
import type { FleetHealth } from '@/hooks/useProjectHealth'
import { formatAgo } from '@/lib/format'
import { getAggregateCi, getCiFailedUrl, getReleaseTag } from '@/lib/statusConstants'
import { useToast } from '@/components/Toast'

type SortKey = 'project' | 'status' | 'changes' | 'last_run' | 'ci' | 'release'
type SortDir = 'asc' | 'desc'

interface ProjectTablePageProps {
  fleet: FleetHealth
  onRefresh: () => Promise<void>
  onPush?: () => void
  issueCounts?: Record<string, { prs: number; issues: number }>
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
}: {
  agents: Agent[]
  runningNames: Set<string>
}) {
  if (agents.length === 0) return <span className="text-text-tertiary">—</span>

  const MAX_VISIBLE = 4
  const visible = agents.slice(0, MAX_VISIBLE)
  const overflow = agents.length - MAX_VISIBLE

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((agent) => {
        const isRunning = runningNames.has(agent.name)
        return (
          <span
            key={agent.id}
            title={agent.schedule ? `schedule: ${agent.schedule}` : 'manual'}
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

export function ProjectTablePage({ fleet, onRefresh, onPush, issueCounts = {} }: ProjectTablePageProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [releasing, setReleasing] = useState<Set<string>>(new Set())
  const [allJobs, setAllJobs] = useState<JobInfo[]>([])
  const [agentsByProject, setAgentsByProject] = useState<Record<string, Agent[]>>({})
  const [sortKey, setSortKey] = useState<SortKey>('last_run')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const data = await fetchJobs()
        if (active) setAllJobs(data.jobs)
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const data = await fetchAgents()
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
    const interval = setInterval(load, 10000)
    return () => { active = false; clearInterval(interval) }
  }, [])

const isReviewRunning = (projectName: string) =>
    allJobs.some(j => j.project === projectName && j.kind === 'review' && j.status === 'running')

  const getLatestVerdict = (projectName: string) =>
    allJobs
      .filter(j => j.project === projectName && j.kind === 'review' && j.status === 'done' && j.verdict)
      .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))[0]?.verdict

  const getRunningAgentNames = (projectName: string): Set<string> =>
    new Set(
      allJobs
        .filter(j => j.project === projectName && j.status === 'running' && j.kind.startsWith('agent:'))
        .map(j => j.kind.slice('agent:'.length))
    )

  const getRecentTs = (name: string) => {
    let max = 0
    for (const j of allJobs) {
      if (j.project !== name) continue
      const t = Math.max(j.started_at || 0, j.finished_at || 0)
      if (t > max) max = t
    }
    return max
  }

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

  const handleRelease = async (e: React.MouseEvent, projectName: string) => {
    e.stopPropagation()
    if (releasing.has(projectName)) return
    setReleasing(prev => new Set(prev).add(projectName))
    try {
      const r = await releaseProject(projectName)
      toast(r.message || `Release started for ${projectName}`, 'success')
      if (onPush) onPush()
      else onRefresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : `Failed to start release for ${projectName}`, 'error')
    } finally {
      setReleasing(prev => {
        const next = new Set(prev)
        next.delete(projectName)
        return next
      })
    }
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
      case 'ci': {
        const ca = getAggregateCi(a)
        const cb = getAggregateCi(b)
        cmp = (ciOrder[ca ?? ''] ?? 99) - (ciOrder[cb ?? ''] ?? 99)
        break
      }
      case 'release': {
        const ra = getReleaseTag(a) ?? ''
        const rb = getReleaseTag(b) ?? ''
        cmp = ra.localeCompare(rb)
        break
      }
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const thClass = (key: SortKey) =>
    `px-4 py-2.5 font-medium cursor-pointer select-none hover:text-text-secondary transition-colors ${sortKey === key ? 'text-text-secondary' : ''}`

  return (
    <div className="overflow-x-auto">
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
            <th className={thClass('ci')} onClick={() => handleSort('ci')}>
              <span className="flex items-center gap-1">CI <SortIcon active={sortKey === 'ci'} dir={sortDir} /></span>
            </th>
            <th className={thClass('release')} onClick={() => handleSort('release')}>
              <span className="flex items-center gap-1">Release <SortIcon active={sortKey === 'release'} dir={sortDir} /></span>
            </th>
            <th className="px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {sortedProjects.map((project) => {
            const ci = getAggregateCi(project)
            const ciUrl = getCiFailedUrl(project)
            const release = getReleaseTag(project)
            const hasUnreviewed = project.unreviewedCount > 0
            const isReviewed = project.totalChanges > 0 && !hasUnreviewed
            const reviewing = isReviewRunning(project.project)
            const verdict = getLatestVerdict(project.project)

            const projectJobs = allJobs.filter(j => j.project === project.project)
            const runningJobs = projectJobs.filter(j => j.status === 'running')
            const jobTime = (j: typeof projectJobs[number]) => j.finished_at ?? j.started_at ?? 0
            const lastJob = projectJobs.slice().sort((a, b) => jobTime(b) - jobTime(a))[0]

            const agents = agentsByProject[project.project] || []
            const runningAgentNames = getRunningAgentNames(project.project)

            // show warning in STATUS only for non-unreviewed reasons (paused, out-of-sync, stale)
            const showWarning = project.status === 'warning' && !hasUnreviewed

            return (
              <tr
                key={project.project}
                className="border-b border-border/50 hover:bg-bg-secondary/40 cursor-pointer transition-colors"
                onClick={() => router.push(`/project/${project.project}`)}
              >
                {/* Project */}
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2">
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
                <td className="px-4 py-3 max-w-[280px]" onClick={e => e.stopPropagation()}>
                  <AgentPills agents={agents} runningNames={runningAgentNames} />
                </td>

                {/* Status */}
                <td className="px-4 py-3">
                  {runningJobs.length > 0 ? (
                    <span className="flex items-center gap-1.5 text-accent text-sm">
                      <SpinnerIcon />
                      {runningJobs.length > 1 ? `${runningJobs.length} running` : runningJobs[0].kind}
                    </span>
                  ) : project.status === 'error' ? (
                    <span className="flex items-center gap-1.5 text-sm text-status-error">
                      <StatusDot ok={false} />
                      <span>error</span>
                    </span>
                  ) : showWarning ? (
                    <span className="flex items-center gap-1.5 text-sm text-status-warning">
                      <WarningDot />
                      <span>warning</span>
                    </span>
                  ) : lastJob ? (
                    <span className="flex items-center gap-1.5 text-sm text-text-tertiary">
                      <StatusDot ok={true} />
                      idle
                    </span>
                  ) : (
                    <span className="text-text-tertiary text-sm">—</span>
                  )}
                </td>

                {/* Changes */}
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
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
                <td className="px-4 py-3">
                  {lastJob ? (
                    <span className="flex items-center gap-1.5">
                      {lastJob.status === 'running' ? (
                        <SpinnerIcon />
                      ) : (
                        <StatusDot ok={lastJob.exit_code === 0} />
                      )}
                      <span className="text-xs text-text-secondary font-medium">{lastJob.kind.startsWith('agent:') ? lastJob.kind.slice(6) : lastJob.kind}</span>
                      <span className="text-xs text-text-tertiary">
                        {lastJob.status === 'running'
                          ? `running · started ${formatAgo(lastJob.started_at)}`
                          : formatAgo(lastJob.finished_at ?? lastJob.started_at)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-text-tertiary text-sm">—</span>
                  )}
                </td>

                {/* CI */}
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
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

                {/* Release */}
                <td className="px-4 py-3 text-sm text-text-tertiary tabular-nums">
                  <span data-private>{release || '—'}</span>
                </td>

                {/* Actions */}
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  {isReviewed && (
                    <button
                      className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-md hover:bg-accent-hover transition-colors cursor-pointer border-none disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={e => handleRelease(e, project.project)}
                      disabled={releasing.has(project.project)}
                    >
                      {releasing.has(project.project) ? 'Releasing…' : '🚀 Release'}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
