'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { fetchProjects } from '@/lib/client-api'
import type { Task } from '@/lib/types'

function formatFiresAt(firesAt: string): string {
  return firesAt || '—'
}

export function AgentsPage() {
  const router = useRouter()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'running' | 'paused' | 'missing'>('all')

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const data = await fetchProjects()
        if (active) {
          setTasks(data.tasks)
          setLoading(false)
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 30000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  const filtered = tasks.filter((t) => {
    if (filter === 'all') return true
    if (filter === 'running') return t.launchctl === 'running' || t.launchctl === 'loaded'
    if (filter === 'paused') return t.launchctl === 'paused'
    if (filter === 'missing') return t.launchctl === 'missing'
    return true
  })

  const runningCount = tasks.filter(t => t.launchctl === 'running' || t.launchctl === 'loaded').length
  const pausedCount = tasks.filter(t => t.launchctl === 'paused').length
  const missingCount = tasks.filter(t => t.launchctl === 'missing').length

  return (
    <div className="p-6">
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="text-xl font-semibold text-text-primary">Agents</h2>
        <div className="flex gap-0.5 border-b border-border">
          {(['all', 'running', 'paused', 'missing'] as const).map((f) => {
            const count =
              f === 'all' ? tasks.length :
              f === 'running' ? runningCount :
              f === 'paused' ? pausedCount :
              missingCount
            const label = f === 'running' ? 'Active' : f[0].toUpperCase() + f.slice(1)
            return (
              <button
                key={f}
                className={`px-3 py-1.5 text-sm cursor-pointer transition-colors border-b-2 -mb-px ${filter === f ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
                onClick={() => setFilter(f)}
              >
                {label} <span className="tabular-nums opacity-70">({count})</span>
              </button>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-10 rounded" style={{ opacity: 1 - i * 0.12 }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.798-1.414 2.798H4.612c-1.444 0-2.414-1.798-1.414-2.798L4.8 15.3" />
          </svg>
          <p className="text-sm text-text-secondary">
            {filter === 'all'
              ? 'No agents configured yet'
              : filter === 'running' ? 'No active agents'
              : filter === 'paused' ? 'No paused agents'
              : 'No missing agents — scheduler is in sync'}
          </p>
          {filter === 'all' && (
            <p className="text-xs text-text-tertiary">
              Open a project and add an agent from the <span className="text-text-secondary">Agents</span> tab, or bulk-create from <a href="/skills" className="text-accent hover:underline">Skills</a>.
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-xs text-text-secondary uppercase tracking-wider border-b border-border">
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Schedule</th>
                <th className="px-4 py-2 font-medium">Priority</th>
                <th className="px-4 py-2 font-medium">Last Run</th>
                <th className="px-4 py-2 font-medium text-right">Duration</th>
                <th className="px-4 py-2 font-medium text-center">Exit</th>
                <th className="px-4 py-2 font-medium text-center">Sync</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => {
                const exitFailed = task.last_run_exit !== null && task.last_run_exit !== 0
                const accent =
                  task.launchctl === 'running' || task.launchctl === 'loaded'
                    ? exitFailed ? 'border-l-status-error' : 'border-l-status-success/40'
                    : task.launchctl === 'paused' ? 'border-l-status-warning/50'
                    : task.launchctl === 'missing' ? 'border-l-status-error/60'
                    : 'border-l-transparent'
                return (
                  <tr
                    key={task.id}
                    className={`border-t border-border hover:bg-bg-secondary/50 cursor-pointer border-l-2 ${accent}`}
                    onClick={() => router.push(`/project/${task.project}`)}
                  >
                    <td className="px-4 py-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${task.launchctl === 'running' || task.launchctl === 'loaded' ? 'bg-status-success/15 text-status-success' : task.launchctl === 'paused' ? 'bg-status-warning/15 text-status-warning' : task.launchctl === 'missing' ? 'bg-status-error/15 text-status-error' : 'bg-bg-tertiary text-text-secondary'}`}>
                        {task.launchctl}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-medium text-text-primary" data-private>{task.project}</td>
                    <td className="px-4 py-2 text-text-secondary" data-private>{task.job || '—'}</td>
                    <td className="px-4 py-2 text-text-secondary font-mono text-xs tabular-nums">
                      {formatFiresAt(task.fires_at)}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {task.priority ? (
                        <span className={`${task.priority === 'critical' ? 'text-status-error' : task.priority === 'high' ? 'text-orange-500' : task.priority === 'medium' ? 'text-accent' : 'text-text-secondary'}`}>
                          {task.priority}
                        </span>
                      ) : <span className="text-text-tertiary">—</span>}
                    </td>
                    <td className="px-4 py-2 text-text-secondary text-sm tabular-nums">
                      {task.last_run_ago ? `${task.last_run_ago} ago` : <span className="text-text-tertiary">—</span>}
                    </td>
                    <td className="px-4 py-2 text-text-secondary text-sm tabular-nums text-right">
                      {task.last_run_duration_s !== null
                        ? task.last_run_duration_s < 60
                          ? `${task.last_run_duration_s}s`
                          : `${Math.floor(task.last_run_duration_s / 60)}m ${task.last_run_duration_s % 60}s`
                        : <span className="text-text-tertiary">—</span>}
                    </td>
                    <td className="px-4 py-2 text-center tabular-nums text-sm">
                      {task.last_run_exit === null ? (
                        <span className="text-text-tertiary">—</span>
                      ) : task.last_run_exit === 0 ? (
                        <span className="text-status-success">0</span>
                      ) : (
                        <span className="text-status-error font-medium">{task.last_run_exit}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {task.sync === null ? (
                        <span className="text-text-tertiary">—</span>
                      ) : task.sync ? (
                        <span className="text-status-success" title="In sync">✓</span>
                      ) : (
                        <span className="text-status-warning" title="Out of sync">✗</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
