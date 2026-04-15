'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { reviewProject, fetchJobs } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'
import type { FleetHealth } from '@/hooks/useProjectHealth'
import { getAggregateCi, getCiFailedUrl, getReleaseTag } from '@/lib/statusConstants'
import { SmartPushModal } from '@/components/SmartPushModal'
import { useToast } from '@/components/Toast'

interface ProjectTablePageProps {
  fleet: FleetHealth
  onRefresh: () => Promise<void>
  onPush?: () => void
}

export function ProjectTablePage({ fleet, onRefresh, onPush }: ProjectTablePageProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [pushProject, setPushProject] = useState<string | null>(null)
  const [allJobs, setAllJobs] = useState<JobInfo[]>([])

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

  const isReviewRunning = (projectName: string) =>
    allJobs.some(j => j.project === projectName && j.kind === 'review' && j.status === 'running')

  const getLatestVerdict = (projectName: string): string | undefined => {
    const reviews = allJobs
      .filter(j => j.project === projectName && j.kind === 'review' && j.status === 'done' && j.verdict)
      .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))
    return reviews[0]?.verdict
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

  const handleDeploy = (e: React.MouseEvent, projectName: string) => {
    e.stopPropagation()
    setPushProject(projectName)
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-xs text-text-secondary uppercase tracking-wider">
            <th className="px-4 py-3">Project</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Agents</th>
            <th className="px-4 py-3">Changes</th>
            <th className="px-4 py-3">Deploy</th>
            <th className="px-4 py-3">Last Run</th>
            <th className="px-4 py-3">CI</th>
            <th className="px-4 py-3">Release</th>
          </tr>
        </thead>
        <tbody>
          {fleet.projects.map((project) => {
            const ci = getAggregateCi(project)
            const ciUrl = getCiFailedUrl(project)
            const release = getReleaseTag(project)
            const hasUnreviewed = project.unreviewedCount > 0
            const isReviewed = project.totalChanges > 0 && !hasUnreviewed
            const reviewing = isReviewRunning(project.project)
            const verdict = getLatestVerdict(project.project)

            // Status: running jobs or last failure info
            const projectJobs = allJobs.filter(j => j.project === project.project)
            const runningJobs = projectJobs.filter(j => j.status === 'running')
            const recentDone = projectJobs
              .filter(j => j.status === 'done')
              .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))
            const lastFailed = recentDone.find(j => j.exit_code !== null && j.exit_code > 0)

            return (
              <tr
                key={project.project}
                className="border-t border-border hover:bg-bg-secondary/50 cursor-pointer"
                onClick={() => router.push(`/project/${project.project}`)}
              >
                <td className="px-4 py-3 font-medium text-text-primary">{project.project}</td>
                <td className="px-4 py-3">
                  {runningJobs.length > 0 ? (
                    <span className="text-status-warning">
                      ⋯ {runningJobs.length} running
                    </span>
                  ) : lastFailed ? (
                    <span className="text-status-error">
                      ✗ {lastFailed.kind} failed
                    </span>
                  ) : recentDone.length > 0 ? (
                    <span className="text-status-success">idle</span>
                  ) : (
                    <span className="text-text-secondary">—</span>
                  )}
                </td>
                <td className="px-4 py-3">{project.tasks.length}</td>
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  {project.totalChanges > 0 ? (
                    <span className="flex items-center gap-2">
                      <span className={hasUnreviewed ? 'text-status-error' : 'text-status-success'}>
                        {project.totalChanges}
                      </span>
                      {hasUnreviewed ? (
                        <button
                          className="px-2 py-0.5 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                          onClick={(e) => handleReview(e, project.project)}
                          disabled={reviewing}
                          title={reviewing ? 'Review in progress' : 'Review changes'}
                        >
                          {reviewing ? 'Reviewing...' : 'Review'}
                        </button>
                      ) : verdict ? (
                        <span className={`text-xs font-medium ${verdict === 'LGTM' ? 'text-status-success' : verdict === 'NEEDS ATTENTION' ? 'text-status-warning' : 'text-status-error'}`}>
                          {verdict === 'LGTM' ? '✅' : verdict === 'NEEDS ATTENTION' ? '⚠️' : '❌'} {verdict}
                        </span>
                      ) : (
                        <span className="text-status-success text-xs">✓</span>
                      )}
                    </span>
                  ) : project.unpushed > 0 ? (
                    <span className="text-status-warning">↑{project.unpushed} unpushed</span>
                  ) : (
                    <span className="text-text-secondary">0</span>
                  )}
                </td>
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  {isReviewed ? (
                    <button
                      className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover"
                      onClick={(e) => handleDeploy(e, project.project)}
                      title="Push reviewed changes"
                    >
                      Push
                    </button>
                  ) : (
                    <span className="text-text-secondary">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-text-secondary text-sm">
                  {project.lastRunAgo ? `${project.lastRunAgo} ago` : '—'}
                </td>
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  {ci === 'success' && <span className="text-status-success">✓</span>}
                  {ci === 'failure' && (
                    ciUrl ? (
                      <a href={ciUrl} target="_blank" rel="noopener noreferrer" className="text-status-error hover:underline">✗</a>
                    ) : (
                      <span className="text-status-error">✗</span>
                    )
                  )}
                  {ci === 'in_progress' && <span className="text-status-warning">⋯</span>}
                  {ci === null && <span className="text-text-secondary">—</span>}
                </td>
                <td className="px-4 py-3 text-text-secondary text-sm">{release || '—'}</td>
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
