'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import { pushProject } from '@/lib/client-api'
import type { JobInfo, ProjectConfig } from '@/lib/client-api'
import { useToast } from '@/components/Toast'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { buildProjectTerminalPath } from '@/lib/client/project-routes'
import { derivePipelineState, type StepState } from '@/lib/pipeline/pipeline-state'

interface PipelineStripProps {
  projectName: string
  projectJobs: JobInfo[]
  config: ProjectConfig | null
  totalChanges: number
  unpushed: number
  hasUnreviewed: boolean
  verdict: string | undefined
  jobsPaused: boolean
  onRefresh: () => Promise<void>
}

function stateClass(state: StepState): string {
  if (state === 'running') return 'border-accent/55 bg-accent/15 text-accent ring-2 ring-accent/35'
  if (state === 'done') return 'border-status-success/40 bg-status-success/12 text-status-success'
  if (state === 'attention') return 'border-status-warning/55 bg-status-warning/15 text-status-warning'
  return 'border-status-error/55 bg-status-error/15 text-status-error'
}

export function PipelineStrip({
  projectName,
  projectJobs,
  config,
  jobsPaused,
  onRefresh,
}: PipelineStripProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [confirmAbort, setConfirmAbort] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [retryingPush, setRetryingPush] = useState(false)

  const pushError = config?.last_push_error?.trim() || null
  const ps = derivePipelineState(projectJobs, { pushError })
  const { traceReleaseId, activeReleaseId, hasActiveRelease, displayJob, steps, summary, doneCount, totalCount } = ps

  // The abort confirm prompt is per-release. When the strip switches to a
  // different release while still mounted, drop any pending confirm so the new
  // release never inherits a stale "abort?" prompt the operator never opened.
  const prevReleaseIdRef = useRef<string | null>(activeReleaseId)
  useEffect(() => {
    if (prevReleaseIdRef.current !== activeReleaseId) {
      prevReleaseIdRef.current = activeReleaseId
      setConfirmAbort(false)
    }
  }, [activeReleaseId])

  if (!displayJob || !summary) return null

  const summaryState = summary.state

  const openJob = (job: JobInfo) => {
    router.push(buildProjectTerminalPath(projectName, {
      sessionId: job.session_id ?? undefined,
      jobId: job.session_id ? undefined : job.id,
    }))
  }

  const retryPush = async () => {
    if (!traceReleaseId || retryingPush) return
    if (jobsPaused) {
      toast('Jobs are paused globally. Resume jobs to start a push.', 'info')
      return
    }
    setRetryingPush(true)
    try {
      const result = await pushProject(projectName, { releaseId: traceReleaseId })
      if (result.job_id) {
        router.push(buildProjectTerminalPath(projectName, { jobId: result.job_id }))
      } else {
        toast('Push started', 'success')
        await onRefresh()
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Push failed', 'error')
    } finally {
      setRetryingPush(false)
    }
  }

  const abortRelease = async () => {
    if (!confirmAbort) {
      setConfirmAbort(true)
      return
    }
    if (aborting) return
    setAborting(true)
    setConfirmAbort(false)
    try {
      const res = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/release/abort`, { method: 'POST' })
      const data = await res.json() as { status?: string; detail?: string }
      if (!res.ok && data.status !== 'abort_pending') {
        throw new Error(data.detail || `HTTP ${res.status}`)
      }
      if (data.status === 'aborted') toast('Pipeline aborted', 'success')
      else if (data.status === 'abort_pending') toast('Pipeline abort pending', 'info')
      else toast('No active pipeline', 'info')
      await onRefresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Abort failed', 'error')
    } finally {
      setAborting(false)
    }
  }

  return (
    <div className="mt-3 mb-3 rounded-md border border-border bg-bg-secondary px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className={`flex min-w-[170px] items-center gap-2 rounded-md border px-2.5 py-2 ${stateClass(summaryState)}`}
          aria-label={`pipeline summary: ${summary.text}`}
          title={summary.hint}
        >
          {summaryState === 'running' ? <Spinner size="md" shrink /> : <span className="text-[10px]">{summaryState === 'done' ? '✓' : '!'}</span>}
          <div className="min-w-0 leading-none">
            <span className="text-[9px] uppercase tracking-[0.18em]">pipeline</span>
            <div className="mt-1 flex items-center gap-2">
              <span className="truncate text-[11px] font-medium text-text-primary">{summary.text}</span>
              <span className="truncate text-[10px]">{summary.hint}</span>
            </div>
          </div>
          <span className="ml-1 rounded-sm bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-current/85">
            {doneCount}/{totalCount}
          </span>
        </div>

        {steps.map((s) => {
          const canRetryPush = !!traceReleaseId && s.kind === 'push' && s.state === 'failed'
          return (
            <span key={s.job.id} className="inline-flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`min-h-[36px] gap-2 rounded-md px-2.5 py-1.5 text-[11px] hover:brightness-110 ${stateClass(s.state)}`}
                onClick={() => openJob(s.job)}
                aria-label={`${s.label}: ${s.state}${s.runs > 1 ? `, ${s.runs} runs` : ''}. ${s.hint}`}
                title={s.runs > 1 ? `${s.hint} (${s.label} ran ${s.runs}×)` : s.hint}
              >
                {s.state === 'running' ? <Spinner size="sm" shrink /> : <span className="text-[10px]">{s.state === 'done' ? '✓' : '!'}</span>}
                <span className="font-medium text-text-primary">{s.label}</span>
                <span className="font-mono text-[9px] uppercase tracking-[0.12em]">{s.state}</span>
                {s.runs > 1 && (
                  <span className="font-mono text-[9px] tabular-nums text-current/70">·{s.runs}</span>
                )}
              </Button>
              {canRetryPush && (
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  className="min-h-[28px] min-w-[24px] justify-center px-1.5 py-0.5 font-mono text-[10px] leading-none"
                  onClick={retryPush}
                  disabled={retryingPush || jobsPaused}
                  title={jobsPaused ? 'Jobs are paused globally. Resume jobs to start a push.' : 'Retry push'}
                  aria-label="retry push"
                >
                  {retryingPush ? <Spinner size="xs" /> : 'retry'}
                </Button>
              )}
            </span>
          )
        })}

        {traceReleaseId && (
          <Link
            href={`/project/${encodeURIComponent(projectName)}/release/${encodeURIComponent(traceReleaseId)}`}
            className={buttonVariants({ variant: 'link', className: 'ml-auto shrink-0 font-mono text-[10px]' })}
            title="View unified release trace"
          >
            trace -&gt;
          </Link>
        )}

        {hasActiveRelease && (
          confirmAbort ? (
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-[10px] font-mono text-text-tertiary">abort?</span>
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="min-w-[28px] justify-center px-1.5 py-0.5 text-[10px] font-mono leading-none"
                onClick={abortRelease}
                disabled={aborting}
                title="Confirm abort"
              >
                {aborting ? <Spinner size="xs" /> : 'yes'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="px-1.5 py-0.5 text-[10px] font-mono leading-none text-text-tertiary"
                onClick={() => setConfirmAbort(false)}
              >
                no
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="danger"
              size="sm"
              className="shrink-0 border-transparent bg-transparent px-1.5 py-0.5 text-[10px] font-mono leading-none text-text-tertiary hover:text-status-error"
              onClick={abortRelease}
              disabled={aborting}
              title="Abort the running pipeline"
            >
              abort
            </Button>
          )
        )}
      </div>
    </div>
  )
}
