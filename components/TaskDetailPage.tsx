'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { fetchTaskDetail } from '@/lib/client-api'
import type { TaskDetail } from '@/lib/client-api'
import { FleetHealth } from '@/hooks/useProjectHealth'
import { formatDuration } from '@/lib/statusConstants'

interface TaskDetailPageProps {
  fleet: FleetHealth
  priorities: string[]
  onPriorityChange: (taskId: string, priority: string) => Promise<void>
  onPause: (taskId: string) => Promise<void>
  onResume: (taskId: string) => Promise<void>
}

export function TaskDetailPage({
  fleet,
  priorities,
  onPriorityChange,
  onPause,
  onResume,
}: TaskDetailPageProps) {
  const params = useParams<{ name: string; task: string }>()
  const name = params.name
  const taskName = params.task
  const router = useRouter()
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const project = fleet.projects.find(p => p.project === name)
  const taskHealth = project?.tasks.find(t => t.task.job === taskName)
  const task = taskHealth?.task

  const schedId = task?.id || `${name}-${taskName}`

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchTaskDetail(schedId)
      .then(setDetail)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [schedId])

  return (
    <div className="p-6">
      <button className="text-accent hover:underline text-sm mb-4 inline-block" onClick={() => router.push(`/project/${name}`)}>
        &larr; Back to {name}
      </button>

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-text-primary">
          {name} / {taskName}
        </h2>
        {task && (
          <div className="flex items-center gap-3">
            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${task.launchctl === 'running' || task.launchctl === 'loaded' ? 'bg-status-success/15 text-status-success' : task.launchctl === 'paused' ? 'bg-status-warning/15 text-status-warning' : 'bg-bg-tertiary text-text-secondary'}`}>
              {task.launchctl}
            </span>
            {task.fires_at && <span className="text-text-secondary text-sm">{task.fires_at}</span>}
            {task.priority && (
              <select
                className="px-2 py-1 text-sm bg-bg-secondary border border-border rounded-md text-text-primary"
                value={task.priority || ''}
                onChange={async (e) => {
                  const val = e.target.value
                  if (val !== (task.priority || '')) {
                    await onPriorityChange(task.id, val)
                  }
                }}
              >
                <option value="">--</option>
                {priorities.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            )}
            {task.ci === 'success' && <span className="text-status-success">CI ✓</span>}
            {task.ci === 'failure' && (
              task.ci_failed_url ? (
                <a href={task.ci_failed_url} target="_blank" rel="noopener noreferrer" className="text-status-error hover:underline">CI ✗</a>
              ) : (
                <span className="text-status-error">CI ✗</span>
              )
            )}
            {task.ci === 'in_progress' && <span className="text-status-warning">CI ⋯</span>}
            <button
              className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
              onClick={() => task.launchctl === 'paused' ? onResume(task.id) : onPause(task.id)}
            >
              {task.launchctl === 'paused' ? '▶ Resume' : '⏸ Pause'}
            </button>
          </div>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-6 animate-pulse">
          <div className="bg-bg-secondary rounded-lg p-4 h-32" />
          <div className="bg-bg-secondary rounded-lg p-4 h-48" />
          <div className="bg-bg-secondary rounded-lg p-4 h-64" />
        </div>
      )}
      {error && <div className="text-status-error">Error: {error}</div>}

      {detail && (
        <div className="flex flex-col gap-6">
          {/* Prompt */}
          <section className="bg-bg-secondary rounded-lg p-4">
            <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Prompt</h3>
            {detail.prompt_path && (
              <div className="font-mono text-xs text-text-secondary mb-2">{detail.prompt_path}</div>
            )}
            {detail.prompt_content ? (
              <pre className="font-mono text-sm text-text-primary whitespace-pre-wrap bg-bg-tertiary rounded-md p-3 overflow-x-auto">{detail.prompt_content}</pre>
            ) : (
              <div className="text-text-secondary text-sm">No prompt file found</div>
            )}
          </section>

          {/* Memory */}
          <section className="bg-bg-secondary rounded-lg p-4">
            <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Memory</h3>
            {detail.memory_path && (
              <div className="font-mono text-xs text-text-secondary mb-2">{detail.memory_path}</div>
            )}
            {detail.memory_content ? (
              <pre className="font-mono text-sm text-text-primary whitespace-pre-wrap bg-bg-tertiary rounded-md p-3 overflow-x-auto">{detail.memory_content}</pre>
            ) : (
              <div className="text-text-secondary text-sm">No memory yet</div>
            )}
          </section>

          {/* Persona */}
          {detail.persona.length > 0 && (
            <section className="bg-bg-secondary rounded-lg p-4">
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Persona</h3>
              <ul className="list-disc list-inside text-sm text-text-primary space-y-1">
                {detail.persona.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </section>
          )}

          {/* Run History */}
          <section className="bg-bg-secondary rounded-lg p-4">
            <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">Run History</h3>
            {detail.run_history.length > 0 ? (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-xs text-text-secondary uppercase tracking-wider">
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3">Exit</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.run_history.map((run, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-4 py-3 text-text-secondary text-sm">
                        {run.started ? new Date(run.started).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-text-secondary text-sm">
                        {run.duration_s !== null ? formatDuration(run.duration_s) : (run.ended ? '—' : 'running...')}
                      </td>
                      <td className="px-4 py-3">
                        {run.exit_code === null ? (
                          <span className="text-status-warning">running</span>
                        ) : run.exit_code === 0 ? (
                          <span className="text-status-success">0</span>
                        ) : (
                          <span className="text-status-error">{run.exit_code}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-text-secondary text-sm">No runs yet</div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
