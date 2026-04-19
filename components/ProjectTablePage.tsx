'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { reviewProject, fetchJobs, fetchAgents } from '@/lib/client-api'
import type { JobInfo, Agent } from '@/lib/client-api'
import type { FleetHealth } from '@/hooks/useProjectHealth'
import { formatAgo } from '@/lib/format'
import { getAggregateCi, getCiFailedUrl, getReleaseTag } from '@/lib/statusConstants'
import { SmartPushModal } from '@/components/SmartPushModal'
import { useToast } from '@/components/Toast'

interface ProjectTablePageProps {
  fleet: FleetHealth
  onRefresh: () => Promise<void>
  onPush?: () => void
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

function SpinnerIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-accent animate-spin shrink-0" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M7 1.5a5.5 5.5 0 1 1-3.889 1.611" />
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

export function ProjectTablePage({ fleet, onRefresh, onPush }: ProjectTablePageProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [pushProject, setPushProject] = useState<string | null>(null)
  const [allJobs, setAllJobs] = useState<JobInfo[]>([])
  const [agentsByProject, setAgentsByProject] = useState<Record<string, Agent[]>>({})

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

  const handleDeploy = (e: React.MouseEvent, projectName: string) => {
    e.stopPropagation()
    setPushProject(projectName)
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-xs text-text-tertiary uppercase tracking-wider border-b border-border">
            <th className="px-4 py-2.5 font-medium">Project</th>
            <th className="px-4 py-2.5 font-medium">Agents</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Changes</th>
            <th className="px-4 py-2.5 font-medium">Last Run</th>
            <th className="px-4 py-2.5 font-medium">CI</th>
            <th className="px-4 py-2.5 font-medium">Release</th>
            <th className="px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {[...fleet.projects]
            .sort((a, b) => {
              const recentTs = (name: string) => {
                let max = 0
                for (const j of allJobs) {
                  if (j.project !== name) continue
                  const t = Math.max(j.started_at || 0, j.finished_at || 0)
                  if (t > max) max = t
                }
                return max
              }
              return recentTs(b.project) - recentTs(a.project)
            })
            .map((project) => {
            const ci = getAggregateCi(project)
            const ciUrl = getCiFailedUrl(project)
            const release = getReleaseTag(project)
            const hasUnreviewed = project.unreviewedCount > 0
            const isReviewed = project.totalChanges > 0 && !hasUnreviewed
            const reviewing = isReviewRunning(project.project)
            const verdict = getLatestVerdict(project.project)

            const projectJobs = allJobs.filter(j => j.project === project.project)
            const runningJobs = projectJobs.filter(j => j.status === 'running')
            // "Last Run" = the single most recent job for this project,
            // regardless of status. Running jobs use started_at; done jobs
            // use finished_at (falling back to started_at).
            const jobTime = (j: typeof projectJobs[number]) => j.finished_at ?? j.started_at ?? 0
            const lastJob = projectJobs.slice().sort((a, b) => jobTime(b) - jobTime(a))[0]
            const lastFailed = lastJob?.status === 'done' && lastJob.exit_code != null && lastJob.exit_code !== 0 ? lastJob : null

            const agents = agentsByProject[project.project] || []
            const runningAgentNames = getRunningAgentNames(project.project)

            return (
              <tr
                key={project.project}
                className="border-b border-border/50 hover:bg-bg-secondary/40 cursor-pointer transition-colors"
                onClick={() => router.push(`/project/${project.project}`)}
              >
                {/* Project */}
                <td className="px-4 py-3">
                  <span className="font-medium text-text-primary">{project.project}</span>
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
                  ) : lastFailed ? (
                    <span className="flex items-center gap-1.5 text-sm text-status-error">
                      <StatusDot ok={false} />
                      <span>{lastFailed.kind}</span>
                      <span className="text-xs text-text-tertiary">{formatAgo(lastFailed.finished_at ?? lastFailed.started_at)}</span>
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
                  {release || '—'}
                </td>

                {/* Deploy */}
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  {isReviewed && (
                    <button
                      className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-md hover:bg-accent-hover transition-colors cursor-pointer border-none"
                      onClick={e => handleDeploy(e, project.project)}
                    >
                      Push
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {pushProject && (
        <SmartPushModal
          projectName={pushProject}
          onClose={() => setPushProject(null)}
          onSuccess={() => {
            setPushProject(null)
            if (onPush) onPush()
            else onRefresh()
          }}
        />
      )}
    </div>
  )
}
