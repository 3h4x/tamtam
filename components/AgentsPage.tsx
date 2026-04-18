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
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-text-primary">Agents</h2>
        <div className="flex gap-1 border-b border-border">
          {(['all', 'running', 'paused', 'missing'] as const).map((f) => (
            <button
              key={f}
              className={`px-3 py-1.5 text-sm cursor-pointer transition-colors ${filter === f ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' && `All (${tasks.length})`}
              {f === 'running' && `Active (${runningCount})`}
              {f === 'paused' && `Paused (${pausedCount})`}
              {f === 'missing' && `Missing (${missingCount})`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 justify-center py-8">
          <div className="spinner" />
          <span className="text-text-secondary">Loading agents...</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.798-1.414 2.798H4.612c-1.444 0-2.414-1.798-1.414-2.798L4.8 15.3" />
          </svg>
          <p className="text-sm text-text-secondary">
            {filter === 'all' ? 'No agents configured — open a project to create one' : `No ${filter} agents`}
          </p>
        </div>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-xs text-text-secondary uppercase tracking-wider">
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3">Project</th>
              <th className="px-4 py-3">Agent</th>
              <th className="px-4 py-3">Schedule</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Last Run</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Exit</th>
              <th className="px-4 py-3">Sync</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((task) => (
              <tr
                key={task.id}
                className="border-t border-border hover:bg-bg-secondary/50 cursor-pointer"
                onClick={() => router.push(`/project/${task.project}`)}
              >
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${task.launchctl === 'running' || task.launchctl === 'loaded' ? 'bg-status-success/15 text-status-success' : task.launchctl === 'paused' ? 'bg-status-warning/15 text-status-warning' : 'bg-bg-tertiary text-text-secondary'}`}>
                    {task.launchctl}
                  </span>
                </td>
                <td className="px-4 py-3 font-medium text-text-primary">{task.project}</td>
                <td className="px-4 py-3">{task.job || '—'}</td>
                <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                  {formatFiresAt(task.fires_at)}
                </td>
                <td className="px-4 py-3">
                  {task.priority && (
                    <span className={`${task.priority === 'critical' ? 'text-status-error' : task.priority === 'high' ? 'text-orange-500' : task.priority === 'medium' ? 'text-accent' : 'text-text-secondary'}`}>
                      {task.priority}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-text-secondary text-sm">
                  {task.last_run_ago ? `${task.last_run_ago} ago` : '—'}
                </td>
                <td className="px-4 py-3 text-text-secondary text-sm">
                  {task.last_run_duration_s !== null
                    ? task.last_run_duration_s < 60
                      ? `${task.last_run_duration_s}s`
                      : `${Math.floor(task.last_run_duration_s / 60)}m ${task.last_run_duration_s % 60}s`
                    : '—'}
                </td>
                <td className="px-4 py-3">
                  {task.last_run_exit === null ? (
                    <span className="text-text-secondary">—</span>
                  ) : task.last_run_exit === 0 ? (
                    <span className="text-status-success">0</span>
                  ) : (
                    <span className="text-status-error">{task.last_run_exit}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {task.sync === null ? (
                    <span className="text-text-secondary">—</span>
                  ) : task.sync ? (
                    <span className="text-status-success">&#10003;</span>
                  ) : (
                    <span className="text-status-warning">&#10007;</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
