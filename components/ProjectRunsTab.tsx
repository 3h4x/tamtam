'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { fetchJobs } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'

function formatDuration(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt || Date.now() / 1000
  const s = Math.floor(end - startedAt)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function formatAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

interface ProjectRunsTabProps {
  projectName: string
}

export function ProjectRunsTab({ projectName }: ProjectRunsTabProps) {
  const router = useRouter()
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'running' | 'done' | 'failed'>('all')

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const data = await fetchJobs(projectName)
        if (active) {
          setJobs(data.jobs.sort((a, b) => b.started_at - a.started_at))
          setLoading(false)
        }
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [projectName])

  const filtered = jobs.filter((j) => {
    if (filter === 'all') return true
    if (filter === 'running') return j.status === 'running'
    if (filter === 'failed') return j.status === 'done' && j.exit_code !== 0
    if (filter === 'done') return j.status === 'done' && j.exit_code === 0
    return true
  })

  const runningCount = jobs.filter(j => j.status === 'running').length
  const failedCount = jobs.filter(j => j.status === 'done' && j.exit_code !== 0).length

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 border-b border-border">
          {(['all', 'running', 'failed', 'done'] as const).map((f) => (
            <button
              key={f}
              className={`px-3 py-1.5 text-sm cursor-pointer ${filter === f ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' && `All (${jobs.length})`}
              {f === 'running' && `Running (${runningCount})`}
              {f === 'failed' && `Failed (${failedCount})`}
              {f === 'done' && `Done (${jobs.length - runningCount - failedCount})`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-text-secondary text-sm">Loading runs...</div>
      ) : filtered.length === 0 ? (
        <div className="text-text-secondary text-sm">
          {filter === 'all' ? 'No runs yet' : `No ${filter} runs`}
        </div>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-xs text-text-secondary uppercase tracking-wider">
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Exit</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((job) => {
              const isRunning = job.status === 'running'
              const isFailed = !isRunning && job.exit_code !== 0
              return (
                <tr
                  key={job.id}
                  className="border-t border-border hover:bg-bg-secondary/50 cursor-pointer"
                  onClick={() => router.push(job.kind === 'run' ? (job.session_id ? `/project/${projectName}/experimental/${job.session_id}` : `/project/${projectName}/experimental`) : `/project/${projectName}/jobs/${job.id}`)}
                >
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${isRunning ? 'bg-status-warning/15 text-status-warning' : isFailed ? 'bg-status-error/15 text-status-error' : 'bg-status-success/15 text-status-success'}`}>
                      {isRunning ? '● running' : isFailed ? '● failed' : '● done'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-text-primary">{job.kind}</td>
                  <td className="px-4 py-3 text-text-secondary text-sm">
                    {formatAgo(job.started_at)}
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-sm">
                    {formatDuration(job.started_at, job.finished_at)}
                  </td>
                  <td className="px-4 py-3">
                    {job.exit_code === null ? (
                      <span className="text-text-secondary">—</span>
                    ) : job.exit_code === 0 ? (
                      <span className="text-status-success">0</span>
                    ) : (
                      <span className="text-status-error">{job.exit_code}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
