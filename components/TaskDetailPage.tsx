'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { fetchTaskDetail } from '@/lib/client-api'
import type { TaskDetail } from '@/lib/client-api'
import { FleetHealth } from '@/hooks/useProjectHealth'
import { formatDuration } from '@/lib/shared/statusConstants'
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes'
import { ErrorState } from '@/components/ErrorState'
import { Button } from '@/components/ui/Button'
import { Table, type Column } from '@/components/ui/Table'

type RunHistoryEntry = TaskDetail['run_history'][number]
const TASK_DETAIL_POLL_MS = 5000

function renderExitState(run: RunHistoryEntry) {
  if (run.exit_code === null) {
    return <span className="text-status-warning">running</span>
  }
  if (run.exit_code === 0) {
    return <span className="text-status-success">0</span>
  }
  if (isCancelledExitCode(run.exit_code)) {
    return <span className="text-status-warning">cancelled</span>
  }
  return <span className="text-status-error">{run.exit_code}</span>
}

const runHistoryColumns: Column<RunHistoryEntry>[] = [
  {
    key: 'started',
    label: 'Started',
    render: (run) => (
      <span className="text-text-secondary">
        {run.started ? new Date(run.started).toLocaleString() : '—'}
      </span>
    ),
  },
  {
    key: 'duration',
    label: 'Duration',
    render: (run) => (
      <span className="text-text-secondary">
        {run.duration_s !== null ? formatDuration(run.duration_s) : (run.ended ? '—' : 'running...')}
      </span>
    ),
  },
  {
    key: 'exit',
    label: 'Exit',
    render: (run) => renderExitState(run),
  },
]

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
  const requestTokenRef = useRef(0)

  const project = fleet.projects.find(p => p.project === name)
  const taskHealth = project?.tasks.find(t => t.task.job === taskName)
  const task = taskHealth?.task

  const schedId = task?.id || `${name}-${taskName}`

  useEffect(() => {
    let cancelled = false

    const loadDetail = async (mode: 'initial' | 'poll') => {
      const token = ++requestTokenRef.current
      if (mode === 'initial') {
        setLoading(true)
      }
      try {
        const nextDetail = await fetchTaskDetail(schedId)
        if (cancelled || requestTokenRef.current !== token) return
        setDetail(nextDetail)
        setError(null)
      } catch (err) {
        if (cancelled || requestTokenRef.current !== token) return
        setError(err instanceof Error ? err.message : 'Failed to fetch task detail')
      } finally {
        if (!cancelled && requestTokenRef.current === token) {
          setLoading(false)
        }
      }
    }

    void loadDetail('initial')
    const interval = setInterval(() => {
      void loadDetail('poll')
    }, TASK_DETAIL_POLL_MS)

    return () => {
      cancelled = true
      requestTokenRef.current += 1
      clearInterval(interval)
    }
  }, [schedId])

  return (
    <div className="p-6">
      <Button
        variant="ghost"
        className="mb-4 px-0 py-0 text-accent hover:bg-transparent hover:text-accent hover:underline font-normal"
        onClick={() => router.push(`/project/${encodeURIComponent(name)}`)}
      >
        &larr; Back to {name}
      </Button>

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-text-primary">
          {name} / {taskName}
        </h2>
        {task && (
          <div className="flex items-center gap-3">
            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${task.paused ? 'bg-status-warning/15 text-status-warning' : 'bg-status-success/15 text-status-success'}`}>
              {task.paused ? 'paused' : 'active'}
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
            <Button
              onClick={() => task.paused ? onResume(task.id) : onPause(task.id)}
            >
              {task.paused ? 'Resume' : 'Pause'}
            </Button>
          </div>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-6">
          {[
            { h: 'h-32', titleW: 'w-20' },
            { h: 'h-48', titleW: 'w-24' },
            { h: 'h-64', titleW: 'w-28' },
          ].map((s, i) => (
            <div key={i} className="bg-bg-secondary rounded-lg p-4 flex flex-col gap-3">
              <div className={`skeleton h-3.5 ${s.titleW} rounded`} />
              <div className={`skeleton ${s.h} rounded-md`} />
            </div>
          ))}
        </div>
      )}
      {error && <ErrorState message={`Error: ${error}`} />}

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
            <Table
              columns={runHistoryColumns}
              rows={detail.run_history}
              getRowKey={(run) => `${run.started ?? ''}|${run.ended ?? ''}|${run.exit_code ?? ''}`}
              emptyState={<div className="px-3 py-2.5 text-text-secondary text-sm">No runs yet</div>}
            />
          </section>
        </div>
      )}
    </div>
  )
}
