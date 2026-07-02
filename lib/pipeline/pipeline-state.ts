import type { JobInfo } from '@/lib/client/types'

// Pure derivation of a project's current pipeline state from its job list.
// Extracted from components/project-detail/PipelineStrip.tsx so the same
// single source of truth can feed the strip, a shared ReleaseStrip, the header
// release control, and the Terminal tab — instead of each re-deriving it.

export type StepState = 'running' | 'done' | 'failed' | 'attention'

export const PIPELINE_KIND_ORDER = ['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait', 'soak'] as const
export const PIPELINE_KINDS = new Set<string>(PIPELINE_KIND_ORDER)

export function kindLabel(kind: string): string {
  if (kind === 'mark-dod') return 'dod'
  if (kind === 'pr-wait') return 'merge'
  return kind
}

export function readDodCounts(job: JobInfo): { verified: number; total: number } | null {
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

export function stateOf(job: JobInfo): StepState {
  if (job.status === 'running') return 'running'
  if (job.kind === 'review') {
    if (job.verdict === 'LGTM') return 'done'
    if (job.verdict === 'NEEDS ATTENTION') return 'attention'
    return 'failed'
  }
  const dodCounts = readDodCounts(job)
  if (dodCounts && dodCounts.total > 0 && dodCounts.verified < dodCounts.total) return 'attention'
  if (job.exit_code === 0) return 'done'
  return 'failed'
}

export function hintFor(job: JobInfo, pushError: string | null = null): string {
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

export function latestJob(jobs: JobInfo[], matches: (job: JobInfo) => boolean): JobInfo | null {
  let latest: JobInfo | null = null
  for (const job of jobs) {
    if (!matches(job)) continue
    if (!latest || (job.started_at ?? 0) > (latest.started_at ?? 0)) latest = job
  }
  return latest
}

export function releaseIdFor(job: JobInfo, jobsById: Map<string, JobInfo>): string | null {
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

export function belongsToRelease(job: JobInfo, releaseId: string, jobsById: Map<string, JobInfo>): boolean {
  return releaseIdFor(job, jobsById) === releaseId
}

export function standaloneParentChainIds(job: JobInfo | null, jobsById: Map<string, JobInfo>): Set<string> {
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

export function latestPipelineJobsByKind(jobs: JobInfo[]): JobInfo[] {
  const latestByKind = new Map<string, JobInfo>()
  for (const job of jobs) {
    const existing = latestByKind.get(job.kind)
    if (!existing || (job.started_at ?? 0) > (existing.started_at ?? 0)) latestByKind.set(job.kind, job)
  }
  return PIPELINE_KIND_ORDER
    .map((kind) => latestByKind.get(kind))
    .filter((job): job is JobInfo => !!job)
}

export interface PipelineStepView {
  job: JobInfo
  kind: string
  label: string
  state: StepState
  runs: number
  hint: string
}

export interface PipelineTrackPhase {
  kind: string
  label: string
  /** Present (started) step, or null when the phase hasn't run yet. */
  step: PipelineStepView | null
  status: StepState | 'pending'
}

export interface PipelineState {
  activeReleaseId: string | null
  traceReleaseId: string | null
  hasActiveRelease: boolean
  /** The job the strip anchors on; null → nothing to show (caller renders nothing). */
  displayJob: JobInfo | null
  running: boolean
  steps: PipelineStepView[]
  /** The full ordered 8-phase track (started + pending), for a ReleaseStrip. */
  track: PipelineTrackPhase[]
  summary: { label: string; state: StepState; text: string; hint: string } | null
  runningStepId: string | null
  doneCount: number
  totalCount: number
}

/**
 * Derive the current pipeline state from a project's job list. Mirrors the
 * derivation PipelineStrip used inline: prefers the active release's chain,
 * falls back to a standalone pipeline chain, collapses each kind to its latest
 * job, and surfaces run counts, the summary step, and progress.
 */
export function derivePipelineState(projectJobs: JobInfo[], opts: { pushError?: string | null } = {}): PipelineState {
  const pushError = opts.pushError ?? null
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
    : latestJob(projectJobs, (job) => PIPELINE_KINDS.has(job.kind) && job.status === 'running')
  const activePipelineJob = activeReleasePipelineJob ?? activeStandalonePipelineJob
  const traceReleaseId = activeReleaseId ?? (activePipelineJob ? releaseIdFor(activePipelineJob, jobsById) : null)
  const displayJob = activeReleasePipelineJob ?? activeRelease ?? activeStandalonePipelineJob

  const emptyState: PipelineState = {
    activeReleaseId,
    traceReleaseId,
    hasActiveRelease: !!activeRelease,
    displayJob: null,
    running: false,
    steps: [],
    track: PIPELINE_KIND_ORDER.map((kind) => ({ kind, label: kindLabel(kind), step: null, status: 'pending' as const })),
    summary: null,
    runningStepId: null,
    doneCount: 0,
    totalCount: 1,
  }
  if (!displayJob) return emptyState

  const standaloneChainIds = traceReleaseId ? null : standaloneParentChainIds(activePipelineJob, jobsById)
  const chainJobs = traceReleaseId
    ? releaseScopedJobs
    : projectJobs.filter((job) => PIPELINE_KINDS.has(job.kind) && (standaloneChainIds?.has(job.id) ?? false))
  const visibleJobs = latestPipelineJobsByKind(chainJobs)

  const runsByKind = new Map<string, number>()
  for (const job of chainJobs) runsByKind.set(job.kind, (runsByKind.get(job.kind) ?? 0) + 1)

  const steps: PipelineStepView[] = visibleJobs.map((job) => ({
    job,
    kind: job.kind,
    label: kindLabel(job.kind),
    state: stateOf(job),
    runs: runsByKind.get(job.kind) ?? 1,
    hint: hintFor(job, pushError),
  }))
  const stepByKind = new Map(steps.map((s) => [s.kind, s]))
  const track: PipelineTrackPhase[] = PIPELINE_KIND_ORDER.map((kind) => {
    const step = stepByKind.get(kind) ?? null
    return { kind, label: kindLabel(kind), step, status: step ? step.state : ('pending' as const) }
  })

  const runningStep = steps.find((s) => s.state === 'running') ?? null
  const attentionStep = steps.find((s) => s.state === 'failed' || s.state === 'attention') ?? null
  const summaryStepView = runningStep
    ?? attentionStep
    ?? steps.find((s) => s.job.id === displayJob.id)
    ?? { job: displayJob, kind: displayJob.kind, label: kindLabel(displayJob.kind), state: stateOf(displayJob), runs: 1, hint: hintFor(displayJob, pushError) }
  const summaryState = summaryStepView.state
  const summary = {
    label: summaryStepView.label,
    state: summaryState,
    text: `${summaryStepView.label} ${summaryState === 'attention' ? 'needs attention' : summaryState}`,
    hint: summaryStepView.hint.replace(/\s+—\s+click to .*$/i, ''),
  }

  return {
    activeReleaseId,
    traceReleaseId,
    hasActiveRelease: !!activeRelease,
    displayJob,
    running: !!runningStep || displayJob.status === 'running',
    steps,
    track,
    summary,
    runningStepId: runningStep?.job.id ?? null,
    doneCount: steps.filter((s) => s.state === 'done').length,
    totalCount: Math.max(steps.length, 1),
  }
}
