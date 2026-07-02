'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ErrorState } from './ErrorState'
import { resolveGithubBoardUrl } from '@/lib/client/resolve-github-board-url'
import { buttonVariants } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { PipelineTimeline } from '@/components/project-runs/PipelineTimeline'
import { formatDurationMs } from '@/lib/shared/format'
import type { JobTraceStep } from '@/lib/jobs/job-trace-types'

type ReleaseStep = JobTraceStep

interface ReleaseTrigger {
  job_id: string
  kind: string
  label: string
  prompt: string | null
  started_at: number
  finished_at: number | null
  exit_code: number | null
}

interface ReleaseTrace {
  release_id: string
  project: string
  branch: string | null
  status: 'running' | 'done' | 'aborted'
  started_at: number
  finished_at: number | null
  exit_code: number | null
  trigger: ReleaseTrigger | null
  steps: ReleaseStep[]
}


function formatTs(secs: number): string {
  return new Date(secs * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}

interface Props {
  projectName: string
  releaseId: string
}

export function ReleaseTraceView({ projectName, releaseId }: Props) {
  const [trace, setTrace] = useState<ReleaseTrace | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [boardUrl, setBoardUrl] = useState<string>('')
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        const s = data?.settings ?? data
        setBoardUrl(resolveGithubBoardUrl(s))
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let shouldPoll = true

    const load = async () => {
      try {
        const res = await fetch(
          `/api/projects/by-project/${encodeURIComponent(projectName)}/release/${encodeURIComponent(releaseId)}`,
        )
        if (!res.ok) {
          shouldPoll = false
          setError(res.status === 404 ? 'Release not found' : `Error ${res.status}`)
          return
        }
        setError(null)
        setTrace(await res.json())
      } catch {
        shouldPoll = false
        setError('Failed to load release trace')
      }
    }
    setTrace(null)
    setError(null)
    load()
    // Poll while running
    const id = setInterval(async () => {
      if (!shouldPoll) {
        clearInterval(id)
        return
      }
      try {
        const res = await fetch(
          `/api/projects/by-project/${encodeURIComponent(projectName)}/release/${encodeURIComponent(releaseId)}`,
        )
        if (!res.ok) return
        const data: ReleaseTrace = await res.json()
        setTrace(data)
        if (data.finished_at !== null) clearInterval(id)
      } catch {}
    }, 4000)
    return () => clearInterval(id)
  }, [projectName, releaseId, reloadNonce])

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <ErrorState
          message={error}
          hint={`Release id ${releaseId}`}
          onRetry={() => {
            setError(null)
            setReloadNonce((n) => n + 1)
          }}
        />
      </div>
    )
  }

  if (!trace) {
    return (
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2 flex-1">
              <div className="skeleton h-4 w-32" />
              <div className="skeleton h-3 w-48" />
            </div>
            <div className="skeleton h-6 w-20 rounded-full" />
          </div>
          <div className="flex gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-3 w-16" />
            ))}
          </div>
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-bg-secondary p-4 flex items-start gap-3">
              <div className="skeleton h-5 w-5 rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-24" />
                <div className="skeleton h-3 w-48" />
              </div>
              <div className="skeleton h-3 w-12" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const isRunning = trace.finished_at === null
  const isCancelled = trace.status === 'aborted'
  const isSuccess = trace.status === 'done' && trace.exit_code === 0 && !isRunning
  const isFailed = !isCancelled && trace.exit_code !== null && trace.exit_code !== 0

  const totalDurationMs = trace.finished_at
    ? Math.round((trace.finished_at - trace.started_at) * 1000)
    : null

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                href={`/project/${encodeURIComponent(projectName)}`}
                className={buttonVariants({ variant: 'link', size: 'md', className: 'font-mono' })}
              >
                {projectName}
              </Link>
              {trace.branch && (
                <span className="text-text-tertiary font-mono text-xs">
                  @ {trace.branch}
                </span>
              )}
            </div>
            <div className="text-text-tertiary text-xs font-mono">
              Release · {releaseId.slice(-12)}
            </div>
            {trace.trigger && (
              <div className="mt-2 text-xs font-mono text-text-tertiary">
                <span className="mr-1">triggered by</span>
                <Link
                  href={`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(trace.trigger.job_id)}`}
                  className={buttonVariants({ variant: 'link', className: 'text-xs font-mono' })}
                >
                  ← {trace.trigger.label}
                </Link>
                {trace.trigger.prompt && (
                  <span className="ml-2 text-text-secondary">
                    “{trace.trigger.prompt.length > 80 ? trace.trigger.prompt.slice(0, 80) + '…' : trace.trigger.prompt}”
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isRunning && (
              <Pill tone="accent" size="sm" className="rounded-full px-2.5 bg-accent/20 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                running
              </Pill>
            )}
            {isSuccess && (
              <Pill tone="success" size="sm" className="rounded-full px-2.5 font-mono">
                success
              </Pill>
            )}
            {isCancelled && (
              <Pill tone="error" size="sm" className="rounded-full px-2.5 font-mono">
                cancelled
              </Pill>
            )}
            {isFailed && (
              <Pill tone="error" size="sm" className="rounded-full px-2.5 font-mono">
                failed
              </Pill>
            )}
            {boardUrl && (
              <a
                href={`${boardUrl}?filterQuery=${encodeURIComponent(releaseId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({
                  variant: 'secondary',
                  size: 'sm',
                  className: 'rounded-full bg-bg-primary px-2.5 font-mono font-normal text-text-secondary hover:border-accent/40 hover:bg-bg-primary hover:text-accent',
                })}
                title="View this run on the GitHub project board"
              >
                Board ↗
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-text-tertiary font-mono">
          <span>started {formatTs(trace.started_at)}</span>
          {trace.finished_at && (
            <span>finished {formatTs(trace.finished_at)}</span>
          )}
          {totalDurationMs !== null && (
            <span>total {formatDurationMs(totalDurationMs)}</span>
          )}
          <span>{trace.steps.length} step{trace.steps.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Timeline */}
      <PipelineTimeline steps={trace.steps} projectName={projectName} />
    </div>
  )
}
