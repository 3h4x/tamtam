'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { pushProject } from '@/lib/client-api'
import type { JobInfo, ProjectConfig } from '@/lib/client-api'
import { useToast } from '@/components/Toast'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { buildProjectTerminalPath } from '@/lib/client/project-routes'

type StepState = 'running' | 'done' | 'failed' | 'attention'

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

const PIPELINE_KIND_ORDER = ['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait', 'soak'] as const
const PIPELINE_KINDS = new Set<string>(PIPELINE_KIND_ORDER)

function kindLabel(kind: string): string {
  if (kind === 'mark-dod') return 'dod'
  if (kind === 'pr-wait') return 'merge'
  return kind
}

function readDodCounts(job: JobInfo): { verified: number; total: number } | null {
  if (job.kind !== 'mark-dod' || !job.context_meta) return null
  try {
    const meta = JSON.parse(job.context_meta) as { verified?: unknown; total?: unknown }
    if (typeof meta.verified === 'number' && typeof meta.total === 'number') {
      return { verified: meta.verified, total: meta.total }
    }
  } catch {
    return null
  }
  return null
}

function stateOf(job: JobInfo): StepState {
  if (job.status === 'running') return 'running'
  if (job.kind === 'review') {
    if (job.verdict === 'LGTM') return 'done'
    if (job.verdict === 'NEEDS ATTENTION') return 'attention'
    if (job.verdict === 'DO NOT SHIP') return 'failed'
    return 'failed'
  }
  const dodCounts = readDodCounts(job)
  if (dodCounts && dodCounts.total > 0 && dodCounts.verified < dodCounts.total) return 'attention'
  if (job.exit_code === 0) return 'done'
  return 'failed'
}

function stateClass(state: StepState): string {
  if (state === 'running') return 'border-accent/55 bg-accent/15 text-accent ring-2 ring-accent/35'
  if (state === 'done') return 'border-status-success/40 bg-status-success/12 text-status-success'
  if (state === 'attention') return 'border-status-warning/55 bg-status-warning/15 text-status-warning'
  return 'border-status-error/55 bg-status-error/15 text-status-error'
}

function hintFor(job: JobInfo, pushError: string | null = null): string {
  if (job.kind === 'test' && job.status === 'running') return 'tests running — click to open terminal'
  if (job.kind === 'review' && job.status === 'running') return 'review in progress — click to open terminal'
  if (job.kind === 'fix' && job.status === 'running') return 'fix in progress — click to open terminal'
  if (job.kind === 'commit' && job.status === 'running') return 'commit in progress — click to open terminal'
  if (job.kind === 'push' && job.status === 'running') return 'push in progress — click to open terminal'
  if (job.kind === 'mark-dod' && job.status === 'running') return 'DoD verification in progress — click to open terminal'
  if (job.kind === 'pr-wait' && job.status === 'running') return 'waiting for CI checks and auto-merge — click to open terminal'
  if (job.kind === 'soak' && job.status === 'running') return 'watching default-branch CI on the merge commit — click to open terminal'
  if (job.kind === 'review') {
    if (job.verdict) return `verdict: ${job.verdict} — click to view findings`
    if (job.exit_code !== 0) return `review job failed${job.exit_code != null ? ` (exit ${job.exit_code})` : ''} — click to view log`
    return 'verdict: unknown — click to view log'
  }
  if (job.kind === 'mark-dod') {
    const counts = readDodCounts(job)
    if (counts && counts.total > 0) {
      const unticked = counts.total - counts.verified
      return `DoD: ${counts.verified} / ${counts.total} verified${unticked > 0 ? ` — ${unticked} unticked` : ''} — click to view log`
    }
    if (job.exit_code === 0) return 'DoD verified — click to view log'
    return 'DoD verification failed — click to view log'
  }
  if (job.kind === 'push' && job.exit_code !== 0 && pushError) return pushError
  if (job.exit_code === 0) return `${kindLabel(job.kind)} completed — click to view log`
  return `${kindLabel(job.kind)} failed — click to view log`
}

function latestJob(jobs: JobInfo[], matches: (job: JobInfo) => boolean): JobInfo | null {
  let latest: JobInfo | null = null
  for (const job of jobs) {
    if (!matches(job)) continue
    if (!latest || (job.started_at ?? 0) > (latest.started_at ?? 0)) {
      latest = job
    }
  }
  return latest
}

function releaseIdFor(job: JobInfo, jobsById: Map<string, JobInfo>): string | null {
  if (job.release_id) return job.release_id
  let cursor: JobInfo | undefined = job
  const seen = new Set<string>()
  while (cursor?.parent_job_id && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    const parent = jobsById.get(cursor.parent_job_id)
    if (!parent) return null
    if (parent.kind === 'release') return parent.id
    cursor = parent
  }
  return null
}

function belongsToRelease(job: JobInfo, releaseId: string, jobsById: Map<string, JobInfo>): boolean {
  return releaseIdFor(job, jobsById) === releaseId
}

function standaloneParentChainIds(job: JobInfo | null, jobsById: Map<string, JobInfo>): Set<string> {
  const ids = new Set<string>()
  let cursor: JobInfo | undefined = job ?? undefined
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    if (!PIPELINE_KINDS.has(cursor.kind)) break
    ids.add(cursor.id)
    if (!cursor.parent_job_id) break
    const parent = jobsById.get(cursor.parent_job_id)
    if (!parent || parent.kind === 'release') break
    cursor = parent
  }
  return ids
}

function latestPipelineJobsByKind(jobs: JobInfo[]): JobInfo[] {
  const latestByKind = new Map<string, JobInfo>()
  for (const job of jobs) {
    const existing = latestByKind.get(job.kind)
    if (!existing || (job.started_at ?? 0) > (existing.started_at ?? 0)) {
      latestByKind.set(job.kind, job)
    }
  }
  return PIPELINE_KIND_ORDER
    .map((kind) => latestByKind.get(kind))
    .filter((job): job is JobInfo => !!job)
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
  const jobsById = new Map(projectJobs.map((job) => [job.id, job]))

  const activeRelease = latestJob(projectJobs, (job) => job.kind === 'release' && job.status === 'running')
  const activeReleaseId = activeRelease?.id ?? null
  const releaseScopedJobs = activeReleaseId
    ? projectJobs.filter((job) => PIPELINE_KINDS.has(job.kind) && belongsToRelease(job, activeReleaseId, jobsById))
    : []
  const activeReleasePipelineJob = activeReleaseId
    ? latestJob(releaseScopedJobs, (job) => job.status === 'running')
    : null
  const activeStandalonePipelineJob = activeReleaseId
    ? null
    : latestJob(
        projectJobs,
        (job) => PIPELINE_KINDS.has(job.kind) && job.status === 'running',
      )
  const activePipelineJob = activeReleasePipelineJob ?? activeStandalonePipelineJob
  const traceReleaseId = activeReleaseId ?? (activePipelineJob ? releaseIdFor(activePipelineJob, jobsById) : null)
  const displayJob = activeReleasePipelineJob ?? activeRelease ?? activeStandalonePipelineJob
  if (!displayJob) return null

  const standaloneChainIds = traceReleaseId ? null : standaloneParentChainIds(activePipelineJob, jobsById)
  const chainJobs = traceReleaseId
    ? releaseScopedJobs
    : projectJobs.filter(
        (job) => PIPELINE_KINDS.has(job.kind) && (standaloneChainIds?.has(job.id) ?? false),
      )
  const visibleJobs = latestPipelineJobsByKind(chainJobs)
  const runningStep = traceReleaseId
    ? visibleJobs.find((job) => job.status === 'running') ?? null
    : visibleJobs.find((job) => job.status === 'running') ?? activePipelineJob
  const attentionStep = visibleJobs.find((job) => {
    const state = stateOf(job)
    return state === 'failed' || state === 'attention'
  }) ?? null
  const summaryJob = runningStep ?? attentionStep ?? displayJob
  const summaryLabel = kindLabel(summaryJob.kind)
  const summaryState = stateOf(summaryJob)
  const summaryText = `${summaryLabel} ${summaryState === 'attention' ? 'needs attention' : summaryState}`
  const pushError = config?.last_push_error?.trim() || null
  const summaryHint = hintFor(summaryJob, pushError).replace(/\s+—\s+click to .*$/i, '')
  const doneCount = visibleJobs.filter((job) => stateOf(job) === 'done').length
  const totalCount = Math.max(visibleJobs.length, 1)

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
          aria-label={`pipeline summary: ${summaryText}`}
          title={summaryHint}
        >
          {summaryState === 'running' ? <Spinner size="md" shrink /> : <span className="text-[10px]">{summaryState === 'done' ? '✓' : '!'}</span>}
          <div className="min-w-0 leading-none">
            <span className="text-[9px] uppercase tracking-[0.18em]">pipeline</span>
            <div className="mt-1 flex items-center gap-2">
              <span className="truncate text-[11px] font-medium text-text-primary">{summaryText}</span>
              <span className="truncate text-[10px]">{summaryHint}</span>
            </div>
          </div>
          <span className="ml-1 rounded-sm bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-current/85">
            {doneCount}/{totalCount}
          </span>
        </div>

        {visibleJobs.map((job) => {
          const state = stateOf(job)
          const label = kindLabel(job.kind)
          const hint = hintFor(job, pushError)
          const canRetryPush = !!traceReleaseId && job.kind === 'push' && state === 'failed'
          return (
            <span key={job.id} className="inline-flex items-center gap-1">
              <button
                type="button"
                className={`inline-flex min-h-[36px] items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors hover:brightness-110 ${stateClass(state)}`}
                onClick={() => openJob(job)}
                aria-label={`${label}: ${state}. ${hint}`}
                title={hint}
              >
                {state === 'running' ? <Spinner size="sm" shrink /> : <span className="text-[10px]">{state === 'done' ? '✓' : '!'}</span>}
                <span className="font-medium text-text-primary">{label}</span>
                <span className="font-mono text-[9px] uppercase tracking-[0.12em]">{state}</span>
              </button>
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
            className="ml-auto text-[10px] text-accent hover:underline font-mono shrink-0"
            title="View unified release trace"
          >
            trace -&gt;
          </Link>
        )}

        {activeRelease && (
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
