'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ErrorState } from './ErrorState'
import { resolveGithubBoardUrl } from '@/lib/client/resolve-github-board-url'
import { Spinner } from '@/components/ui/Spinner'

interface ReleaseStep {
  job_id: string
  kind: string
  status: 'running' | 'done' | 'aborted'
  exit_code: number | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  verdict: string | null
  log_excerpt: string
}

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

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

function formatTs(secs: number): string {
  return new Date(secs * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}

function StepGlyph({ step }: { step: ReleaseStep }) {
  if (step.status === 'running') {
    return (
      <Spinner size="xl" color="accent" />
    )
  }
  if (step.status === 'aborted') {
    return <span className="text-status-error font-bold">✗</span>
  }
  if (step.exit_code === 0) {
    return <span className="text-status-success font-bold">✓</span>
  }
  if (step.verdict === 'NEEDS ATTENTION') {
    return <span className="text-status-warning font-bold">!</span>
  }
  if (step.verdict === 'LGTM') {
    return <span className="text-status-success font-bold">✓</span>
  }
  return <span className="text-status-error font-bold">✗</span>
}

function verdictBadge(verdict: string | null) {
  if (!verdict) return null
  const color =
    verdict === 'LGTM'
      ? 'bg-status-success/15 text-status-success border-status-success/30'
      : verdict === 'NEEDS ATTENTION'
        ? 'bg-status-warning/15 text-status-warning border-status-warning/30'
        : 'bg-status-error/15 text-status-error border-status-error/30'
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${color}`}>
      {verdict}
    </span>
  )
}

interface Props {
  projectName: string
  releaseId: string
}

export function ReleaseTraceView({ projectName, releaseId }: Props) {
  const [trace, setTrace] = useState<ReleaseTrace | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedStep, setExpandedStep] = useState<string | null>(null)
  const [boardUrl, setBoardUrl] = useState<string>('')

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
        setTrace(await res.json())
      } catch {
        shouldPoll = false
        setError('Failed to load release trace')
      }
    }
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
  }, [projectName, releaseId])

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <ErrorState
          message={error}
          hint={`Release id ${releaseId}`}
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
                className="text-accent hover:underline font-mono text-sm"
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
                  className="text-accent hover:underline"
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
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-accent/20 text-accent font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                running
              </span>
            )}
            {isSuccess && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-status-success/15 text-status-success font-mono border border-status-success/30">
                success
              </span>
            )}
            {isCancelled && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-status-error/15 text-status-error font-mono border border-status-error/30">
                cancelled
              </span>
            )}
            {isFailed && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-status-error/15 text-status-error font-mono border border-status-error/30">
                failed
              </span>
            )}
            {boardUrl && (
              <a
                href={`${boardUrl}?filterQuery=${encodeURIComponent(releaseId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2.5 py-1 rounded-full bg-bg-primary text-text-secondary font-mono border border-border hover:text-accent hover:border-accent/40 transition-colors"
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
            <span>total {formatDuration(totalDurationMs)}</span>
          )}
          <span>{trace.steps.length} step{trace.steps.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Timeline */}
      {trace.steps.length === 0 ? (
        <div className="text-text-tertiary text-sm font-mono px-2">
          No pipeline steps recorded yet.
        </div>
      ) : (
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[19px] top-4 bottom-4 w-px bg-border" />

          <div className="space-y-3">
            {trace.steps.map((step) => {
              const isOpen = expandedStep === step.job_id
              const dur = step.duration_ms
                ? formatDuration(step.duration_ms)
                : step.finished_at
                  ? formatDuration(Math.round((step.finished_at - step.started_at) * 1000))
                  : null

              return (
                <div key={step.job_id} className="relative pl-10">
                  {/* Node */}
                  <div className="absolute left-[11px] top-3 w-[18px] h-[18px] flex items-center justify-center bg-bg-primary border border-border rounded-full text-[11px]">
                    <StepGlyph step={step} />
                  </div>

                  <div className="rounded-md border border-border bg-bg-secondary overflow-hidden">
                    <button
                      type="button"
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-tertiary transition-colors"
                      onClick={() => setExpandedStep(isOpen ? null : step.job_id)}
                    >
                      <span className={`font-mono text-sm font-semibold w-20 shrink-0 ${
                        step.status === 'running' ? 'text-accent' :
                        step.status === 'aborted' ? 'text-status-error' :
                        step.exit_code === 0 || step.verdict === 'LGTM' ? 'text-text-primary' :
                        step.verdict === 'NEEDS ATTENTION' ? 'text-status-warning' :
                        step.exit_code !== null ? 'text-status-error' : 'text-text-secondary'
                      }`}>
                        {step.kind}
                      </span>
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {verdictBadge(step.verdict)}
                        {dur && (
                          <span className="text-[10px] text-text-tertiary font-mono">{dur}</span>
                        )}
                        {step.status === 'running' && (
                          <span className="text-[10px] text-accent font-mono">running…</span>
                        )}
                        {step.status === 'aborted' && (
                          <span className="text-[10px] text-status-error font-mono">cancelled</span>
                        )}
                      </div>
                      <span className="text-[10px] text-text-tertiary font-mono shrink-0">
                        {formatTs(step.started_at)}
                      </span>
                      <Link
                        href={`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(step.job_id)}`}
                        className="text-[10px] text-accent hover:underline font-mono shrink-0 z-10"
                        onClick={(e) => e.stopPropagation()}
                      >
                        full log →
                      </Link>
                      <span className={`text-text-tertiary text-xs transition-transform ${isOpen ? 'rotate-180' : ''}`}>
                        ▾
                      </span>
                    </button>

                    {isOpen && step.log_excerpt && (
                      <div className="px-4 pb-3 border-t border-border">
                        <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap break-words mt-2 max-h-48 overflow-y-auto leading-relaxed">
                          {step.log_excerpt}
                        </pre>
                      </div>
                    )}
                    {isOpen && !step.log_excerpt && (
                      <div className="px-4 pb-3 border-t border-border">
                        <p className="text-xs text-text-tertiary font-mono mt-2">no log excerpt available</p>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
