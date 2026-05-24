'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { pushProject } from '@/lib/client-api'
import type { JobInfo, ProjectConfig } from '@/lib/client-api'
import { useToast } from '@/components/Toast'
import { Spinner } from '@/components/ui/Spinner'
import { formatAgo } from '@/lib/shared/format'

type StepState = 'pending' | 'running' | 'done' | 'warning' | 'failed' | 'skipped'

interface PipelineStep {
  label: string
  state: StepState
  hint: string
  action?: (() => void) | null
  retryAction?: (() => void) | null
  jobId: string | null
}

interface PipelineJourneyStep extends PipelineStep {
  role: 'start' | 'now' | 'goal'
  meta: string
}

export interface PipelineStripProps {
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

const PIPELINE_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait', 'soak'])

interface PipelineChainContext {
  releaseId: string | null
  visibleJobIds: Set<string>
}

function stepChipClass(s: StepState, isRunning: boolean): string {
  if (s === 'done') return 'bg-status-success/12 text-status-success border-status-success/40'
  if (s === 'failed') return 'bg-status-error/15 text-status-error border-status-error/65'
  if (s === 'warning') return 'bg-status-warning/15 text-status-warning border-status-warning/65'
  if (s === 'running') return `bg-accent/15 text-accent border-accent/55 ${isRunning ? 'ring-2 ring-accent/45' : ''}`
  if (s === 'skipped') return 'bg-bg-tertiary text-text-tertiary border-border/40'
  return 'bg-bg-secondary/40 text-text-tertiary border-border/70'
}

function stateLabel(s: StepState): string {
  if (s === 'done') return 'done'
  if (s === 'failed') return 'failed'
  if (s === 'warning') return 'attention'
  if (s === 'running') return 'running'
  if (s === 'skipped') return 'skipped'
  return 'pending'
}

function visibleStateLabel(s: StepState): string | null {
  if (s === 'done') return 'done'
  if (s === 'running') return 'running'
  if (s === 'failed') return 'failed'
  if (s === 'warning') return 'attention'
  if (s === 'skipped') return 'skipped'
  return 'pending'
}

function stateTextClass(s: StepState): string {
  if (s === 'done') return 'text-status-success'
  if (s === 'failed') return 'text-status-error'
  if (s === 'warning') return 'text-status-warning'
  if (s === 'running') return 'text-accent'
  if (s === 'skipped') return 'text-text-tertiary'
  return 'text-text-secondary'
}

function stateBadgeClass(s: StepState): string {
  if (s === 'done') return 'bg-status-success/12 text-status-success border-status-success/25'
  if (s === 'failed') return 'bg-status-error/12 text-status-error border-status-error/30'
  if (s === 'warning') return 'bg-status-warning/12 text-status-warning border-status-warning/30'
  if (s === 'running') return 'bg-accent/12 text-accent border-accent/30'
  if (s === 'skipped') return 'bg-bg-tertiary text-text-tertiary border-border/50'
  return 'bg-bg-tertiary/70 text-text-secondary border-border/60'
}

function summaryHintText(hint: string): string {
  return hint.replace(/\s+—\s+click to .*$/i, '')
}

function summaryLabel(step: PipelineStep | null, doneCount: number, totalSteps: number): string {
  if (step) {
    if (step.state === 'running') return `${step.label} running`
    if (step.state === 'warning') return `${step.label} needs attention`
    if (step.state === 'failed') return `${step.label} failed`
  }
  return totalSteps > 0 ? `${doneCount}/${totalSteps} done` : 'running'
}

function stepIcon(s: StepState) {
  if (s === 'done') return <span className="text-[10px] leading-none" aria-hidden>✓</span>
  if (s === 'failed') return <span className="text-[10px] leading-none" aria-hidden>✗</span>
  if (s === 'warning') return <span className="text-[10px] leading-none" aria-hidden>!</span>
  if (s === 'running') {
    return (
      <svg
        className="w-3 h-3 text-current animate-spin shrink-0"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M11.9 7A4.9 4.9 0 1 1 7 2.1" opacity="0.35" />
        <path d="M7 2.1A4.9 4.9 0 0 1 11.9 7" />
      </svg>
    )
  }
  if (s === 'skipped') return <span className="text-[10px] leading-none opacity-70" aria-hidden>⤼</span>
  return <span className="text-[10px] leading-none opacity-50" aria-hidden>○</span>
}

function connectorClass(prev: StepState): string {
  if (prev === 'done') return 'bg-status-success/50'
  if (prev === 'failed') return 'bg-status-error/55'
  if (prev === 'warning') return 'bg-status-warning/55'
  if (prev === 'running') return 'bg-accent/50'
  if (prev === 'skipped') return 'bg-border/60'
  return 'bg-border/50'
}

function jobKindLabel(kind: string): string {
  if (kind === 'mark-dod') return 'dod'
  if (kind === 'pr-wait') return 'merge'
  if (kind === 'soak') return 'soak'
  return kind.replace(/-/g, ':')
}

function toJourneyStep(step: PipelineStep, role: PipelineJourneyStep['role'], meta: string): PipelineJourneyStep {
  return { ...step, role, meta }
}

function findLatestJob(
  jobs: Iterable<JobInfo>,
  matches: (job: JobInfo) => boolean,
  timestamp: (job: JobInfo) => number | null | undefined,
): JobInfo | undefined {
  let latest: JobInfo | undefined
  let latestTimestamp = -Infinity
  for (const job of jobs) {
    if (!matches(job)) continue
    const currentTimestamp = timestamp(job) ?? 0
    if (!latest || currentTimestamp > latestTimestamp) {
      latest = job
      latestTimestamp = currentTimestamp
    }
  }
  return latest
}

export function PipelineStrip({
  projectName,
  projectJobs,
  config,
  totalChanges,
  unpushed,
  hasUnreviewed,
  verdict,
  jobsPaused,
  onRefresh,
}: PipelineStripProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [retryingPush, setRetryingPush] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [confirmAbort, setConfirmAbort] = useState(false)
  const jobsById = new Map(projectJobs.map(job => [job.id, job]))

  const resolvePipelineChain = (job: JobInfo): PipelineChainContext => {
    const visibleJobIds = new Set<string>([job.id])
    if (job.release_id) return { releaseId: job.release_id, visibleJobIds }
    const seen = new Set<string>()
    let cursor: JobInfo | undefined = job
    while (cursor?.parent_job_id && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      const parent = jobsById.get(cursor.parent_job_id)
      if (!parent) return { releaseId: null, visibleJobIds }
      if (parent.kind === 'release') return { releaseId: parent.id, visibleJobIds }
      if (!PIPELINE_KINDS.has(parent.kind)) return { releaseId: null, visibleJobIds }
      visibleJobIds.add(parent.id)
      cursor = parent
    }
    return { releaseId: null, visibleJobIds }
  }
  const pipelineJobs = projectJobs.filter(job => PIPELINE_KINDS.has(job.kind))

  const activeReleaseJob = findLatestJob(
    projectJobs,
    (job) => job.kind === 'release' && job.status === 'running',
    (job) => job.started_at,
  )
  const activePipelineJob = findLatestJob(
    pipelineJobs,
    (job) => job.status === 'running',
    (job) => job.started_at,
  )
  const displayReleaseJob = activeReleaseJob ?? activePipelineJob ?? null
  const activePipelineChain = activePipelineJob ? resolvePipelineChain(activePipelineJob) : null
  const traceReleaseId = activeReleaseJob?.id ?? activePipelineChain?.releaseId ?? null

  if (!displayReleaseJob) return null

  const handleRetryPush = async () => {
    if (jobsPaused) {
      toast('Jobs are paused globally. Resume jobs to start a push.', 'info')
      return
    }
    if (retryingPush) return
    setRetryingPush(true)
    try {
      const result = await pushProject(projectName, { releaseId: traceReleaseId })
      if (result.job_id) {
        router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(result.job_id)}`)
      } else {
        toast('Push started', 'success')
        onRefresh()
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Push failed', 'error')
    } finally {
      setRetryingPush(false)
    }
  }

  const handleAbortPipeline = async () => {
    if (aborting) return
    if (!confirmAbort) {
      setConfirmAbort(true)
      return
    }
    setConfirmAbort(false)
    setAborting(true)
    try {
      const res = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/release/abort`, { method: 'POST' })
      const data = await res.json() as { status: string; detail?: string }
      if (res.ok === false && data.status !== 'abort_pending') {
        throw new Error(data.detail || `HTTP ${res.status}`)
      }
      if (data.status === 'aborted') {
        toast('Pipeline aborted', 'success')
      } else if (data.status === 'abort_pending') {
        toast('Pipeline abort pending', 'info')
      } else {
        toast('No active pipeline', 'info')
      }
      onRefresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Abort failed', 'error')
    } finally {
      setAborting(false)
    }
  }

  const hasTestCommand = !!(
    config?.effective_test_command ||
    config?.detected_test_command ||
    projectJobs.some(j => j.kind === 'test' && j.started_at >= (Date.now() / 1000 - 60 * 60))
  )

  const openJob = (j: JobInfo) => {
    const sid = j.session_id
    return () => router.push(sid ? `/project/${encodeURIComponent(projectName)}/terminal/${encodeURIComponent(sid)}` : `/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(j.id)}`)
  }

  const stateOf = (job: JobInfo | undefined): StepState => {
    if (!job) return 'pending'
    if (job.status === 'running') return 'running'
    if (job.exit_code === 0) return 'done'
    return 'failed'
  }

  const windowJobs = projectJobs
    .filter((job) => {
      if (!PIPELINE_KINDS.has(job.kind)) return false
      if (traceReleaseId) return resolvePipelineChain(job).releaseId === traceReleaseId
      return activePipelineChain?.visibleJobIds.has(job.id) ?? false
    })
    .sort((a, b) => (a.started_at || 0) - (b.started_at || 0))

  const latestOfKind = (kind: string): JobInfo | undefined =>
    findLatestJob(windowJobs, (job) => job.kind === kind, (job) => job.started_at)

  const testJob = latestOfKind('test')
  const reviewJob = latestOfKind('review')
  const fixJob = latestOfKind('fix')
  const commitJob = latestOfKind('commit')
  const pushJob = latestOfKind('push')
  const dodJob = latestOfKind('mark-dod')
  const prWaitJob = latestOfKind('pr-wait')
  const soakJob = latestOfKind('soak')
  const latestProjectReview = findLatestJob(
    projectJobs,
    (job) => job.kind === 'review' && job.status === 'done' && !!job.verdict,
    (job) => job.finished_at,
  )

  const runningStepKinds = new Set(
    windowJobs.filter((job) => job.status === 'running').map((job) => job.kind)
  )

  const hasChanges = totalChanges > 0
  const unpushedBool = unpushed > 0
  const autoPush = !!config?.auto_push_enabled
  const reviewDisabled = !!config?.review_disabled
  const pushError = config?.last_push_error ?? null
  const priorPushStart = pushJob?.started_at ?? 0
  const pipelineEpoch = Math.max(
    displayReleaseJob.started_at ?? 0,
    testJob?.started_at ?? 0,
    reviewJob?.started_at ?? 0,
    fixJob?.started_at ?? 0,
    commitJob?.started_at ?? 0,
  )
  const effectivePushError = pipelineEpoch > priorPushStart ? null : pushError
  const pushErrorIsCommit = !!effectivePushError && effectivePushError.startsWith('Commit failed:')
  const latestKnownVerdict = reviewJob?.verdict ?? verdict ?? latestProjectReview?.verdict
  const freshLgtmShip = !reviewDisabled
    && !testJob
    && !reviewJob
    && !!(commitJob || pushJob)
    && latestKnownVerdict === 'LGTM'
    && !hasUnreviewed

  let testState: StepState = hasTestCommand ? stateOf(testJob) : 'pending'
  let testHint = !hasTestCommand
    ? 'no test command'
    : testState === 'running'
      ? 'tests running — click to open terminal'
      : testState === 'done' && testJob
        ? `tests passed (${formatAgo(testJob.finished_at ?? testJob.started_at)}) — click to view log`
        : testState === 'failed'
          ? `tests failed (exit ${testJob?.exit_code}) — click to view log`
          : 'tests not run yet'
  let testAction = testJob ? openJob(testJob) : null

  if (freshLgtmShip && hasTestCommand && !testJob) {
    testState = 'skipped'
    testHint = 'skipped — release used a fresh LGTM and started at commit/push'
    testAction = null
  }

  const reviewRawState = stateOf(reviewJob)
  let reviewState: StepState
  let reviewHint = ''
  let reviewAction: (() => void) | null = null

  if (reviewRawState === 'running' && reviewJob) {
    reviewState = 'running'
    reviewHint = 'review in progress — click to open terminal'
    reviewAction = openJob(reviewJob)
  } else if (reviewJob && reviewRawState === 'failed') {
    reviewState = 'failed'
    reviewHint = `review job failed (exit ${reviewJob.exit_code}) — click to view log`
    reviewAction = openJob(reviewJob)
  } else if (reviewJob && reviewJob.verdict === 'LGTM') {
    const pushInFlight = pushJob?.status === 'running' || commitJob?.status === 'running'
    reviewState = 'done'
    reviewHint = pushErrorIsCommit
      ? 'LGTM — commit blocked by pre-commit hook; click to view review'
      : pushInFlight
        ? 'LGTM — commit & push in progress; click to view review'
        : hasUnreviewed
          ? 'LGTM — files changed since, but verdict is still valid; click to view review'
          : 'LGTM — click to view review log'
    reviewAction = openJob(reviewJob)
  } else if (reviewJob && reviewJob.verdict === 'NEEDS ATTENTION') {
    reviewState = 'warning'
    reviewHint = 'verdict: NEEDS ATTENTION — click to view findings'
    reviewAction = openJob(reviewJob)
  } else if (reviewJob && reviewJob.verdict === 'DO NOT SHIP') {
    reviewState = 'failed'
    reviewHint = 'verdict: DO NOT SHIP — click to view findings'
    reviewAction = openJob(reviewJob)
  } else if (reviewJob) {
    reviewState = 'failed'
    reviewHint = 'verdict: unknown — click to view log'
    reviewAction = openJob(reviewJob)
  } else if (freshLgtmShip && latestProjectReview) {
    reviewState = 'done'
    reviewHint = 'LGTM — fresh review reused for this release; click to view review'
    reviewAction = openJob(latestProjectReview)
  } else if (reviewDisabled) {
    reviewState = 'skipped'
    reviewHint = 'skipped — review is disabled for this project'
  } else {
    reviewState = 'pending'
    reviewHint = 'not run yet — click Release'
  }

  const shortCircuited =
    testState === 'done' &&
    !hasChanges &&
    !reviewJob &&
    !!pushJob

  if (shortCircuited && reviewState === 'pending') {
    reviewState = 'skipped'
    reviewHint = 'skipped — tests passed and there are no uncommitted changes (short-circuit to push)'
  }

  let fixState: StepState = fixJob?.status === 'running' ? 'running'
    : fixJob && fixJob.exit_code === 0 ? 'done'
    : fixJob && fixJob.exit_code !== 0 ? 'failed'
    : reviewState === 'done' || reviewState === 'skipped' ? 'done'
    : 'pending'
  let fixHint = fixJob?.status === 'running' ? 'fix in progress — click to open terminal'
    : fixJob?.exit_code === 0 ? 'fix applied — click to view log'
    : fixJob && fixJob.exit_code !== 0 ? `fix failed (exit ${fixJob.exit_code}) — click to view log`
    : reviewState === 'done' || reviewState === 'skipped' ? 'no fix needed'
    : 'waiting for review verdict'
  const fixAction = fixJob ? openJob(fixJob) : null

  if (shortCircuited && fixState === 'pending') {
    fixState = 'skipped'
    fixHint = 'skipped — review was bypassed, no fix needed'
  }

  const commitRunning = commitJob?.status === 'running'
  let commitState: StepState = commitRunning
    ? 'running'
    : commitJob?.exit_code === 0 ? 'done'
    : commitJob && commitJob.exit_code !== 0 ? 'failed'
    : pushErrorIsCommit ? 'failed'
    : hasChanges ? 'pending' : 'done'
  let commitHint = commitState === 'failed'
    ? (commitJob ? `commit failed (exit ${commitJob.exit_code}) — click to view log` : (effectivePushError ?? 'commit failed'))
    : commitState === 'done'
      ? 'nothing to commit'
      : commitState === 'running'
        ? 'commit in progress — click to open terminal'
        : reviewState === 'done' || reviewState === 'skipped'
          ? `${totalChanges} uncommitted change${totalChanges === 1 ? '' : 's'} — ${autoPush ? 'auto-commit pending' : 'commit manually'}`
          : `${totalChanges} uncommitted change${totalChanges === 1 ? '' : 's'} — need LGTM review to proceed`
  let commitAction = commitJob ? openJob(commitJob) : null

  if (shortCircuited && !commitJob) {
    commitState = 'skipped'
    commitHint = 'skipped — nothing to commit, release pushed existing commits'
    commitAction = null
  }

  if (freshLgtmShip && !commitJob && hasChanges) {
    commitState = 'pending'
    commitHint = `${totalChanges} uncommitted change${totalChanges === 1 ? '' : 's'} — release should start here from fresh LGTM`
  }

  const pushRunning = pushJob?.status === 'running'
  const pushState: StepState = pushRunning
    ? 'running'
    : pushJob?.exit_code === 0 ? 'done'
    : pushJob && pushJob.exit_code !== 0 ? 'failed'
    : effectivePushError && !pushErrorIsCommit ? 'failed'
    : !hasChanges && !unpushedBool ? 'done' : 'pending'
  const pushHint = pushRunning
    ? 'push in progress — click to open terminal'
    : pushState === 'failed'
    ? (effectivePushError ?? `push failed${pushJob?.exit_code != null ? ` (exit ${pushJob.exit_code})` : ''}`)
    : pushState === 'done'
      ? 'nothing to push'
      : unpushedBool
        ? `${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}${autoPush && (reviewState === 'done' || reviewState === 'skipped') ? ' — auto-push pending' : ''}`
        : `${totalChanges} uncommitted change${totalChanges === 1 ? '' : 's'} — need review & commit first`
  const pushAction = pushJob ? openJob(pushJob) : null
  const pushRetryAction = pushState === 'failed' && !pushErrorIsCommit ? handleRetryPush : null

  function readDodCounts(job: JobInfo | undefined): { verified: number; total: number } | null {
    if (!job?.context_meta) return null
    try {
      const meta = JSON.parse(job.context_meta) as { verified?: number | null; total?: number | null }
      if (typeof meta.verified === 'number' && typeof meta.total === 'number') {
        return { verified: meta.verified, total: meta.total }
      }
    } catch { /* malformed contextMeta — fall through */ }
    return null
  }
  const dodCounts = readDodCounts(dodJob)
  let dodState: StepState
  if (!dodJob) {
    dodState = 'pending'
  } else if (dodJob.status === 'running') {
    dodState = 'running'
  } else if (dodJob.exit_code !== 0) {
    dodState = 'failed'
  } else if (dodCounts && dodCounts.total > 0) {
    if (dodCounts.verified === 0) dodState = 'warning'
    else if (dodCounts.verified < dodCounts.total) dodState = 'warning'
    else dodState = 'done'
  } else {
    dodState = 'done'
  }
  const dodHint = dodJob?.status === 'running'
    ? 'DoD verification in progress — click to open terminal'
    : dodJob && dodCounts && dodCounts.total > 0
      ? `DoD: ${dodCounts.verified} / ${dodCounts.total} verified${dodCounts.verified < dodCounts.total ? ` — ${dodCounts.total - dodCounts.verified} unticked` : ''} — click to view log`
      : dodJob?.exit_code === 0 ? 'DoD verified — click to view log'
      : dodJob && dodJob.exit_code !== 0 ? 'DoD verification failed — click to view log'
      : reviewState === 'done' ? 'waiting for push'
      : 'waiting for LGTM review'
  const dodAction = dodJob ? openJob(dodJob) : null

  // Surface PR creation as its own chip. The push job stores
   //   context_meta = JSON.stringify({ prUrl, prNumber, prRepo })
  // when it opens or attaches a PR; pr-wait carries the same fields once it
  // takes over. We don't have a dedicated `pr` job kind today, so we derive
  // the chip from whichever of push / pr-wait carries the URL — that gives
  // users a visible, clickable "pr" step in the strip without forcing a
  // pipeline state-machine rewrite.
  function readPrUrl(job: JobInfo | undefined): { url: string; number?: number; repo?: string } | null {
    if (!job?.context_meta) return null
    try {
      const meta = JSON.parse(job.context_meta) as { prUrl?: string; prNumber?: number; prRepo?: string }
      if (meta && typeof meta.prUrl === 'string' && meta.prUrl) {
        return { url: meta.prUrl, number: meta.prNumber, repo: meta.prRepo }
      }
    } catch { /* malformed contextMeta — treat as no PR */ }
    return null
  }
  const prInfo = readPrUrl(pushJob) ?? readPrUrl(prWaitJob)
  let prState: StepState
  let prHint = ''
  let prAction: (() => void) | null = null
  if (pushState === 'running' || pushState === 'pending') {
    prState = 'pending'
    prHint = 'waiting for push to open PR'
  } else if (pushState === 'failed') {
    prState = 'failed'
    prHint = 'push failed — PR not created'
  } else if (prInfo) {
    prState = 'done'
    const numPart = prInfo.number ? ` #${prInfo.number}` : ''
    prHint = `PR${numPart} created — click to open in GitHub`
    prAction = () => { window.open(prInfo.url, '_blank', 'noopener,noreferrer') }
  } else {
    // Push succeeded but no PR was opened — direct push on default branch.
    prState = 'skipped'
    prHint = 'no PR — pushed directly to default branch'
  }
  // On the default branch the release pushes directly — no PR is opened, so
  // the `pr` chip is permanently irrelevant. Hide it regardless of push state.
  // Off the default branch (or when branch context is unknown) keep the chip
  // visible while a PR is pending/failed/known so the user can see the slot.
  const onDefaultBranch = config?.file_config_is_default_branch === true
  const showPrChip = !onDefaultBranch
    && !!pushJob
    && (!!prInfo || prState === 'pending' || prState === 'failed')

  const prWaitState = stateOf(prWaitJob)
  const prWaitHint = prWaitJob?.status === 'running'
    ? 'waiting for CI checks and auto-merge — click to open terminal'
    : prWaitJob?.exit_code === 0
      ? 'PR merged after CI passed — click to view log'
      : prWaitJob && prWaitJob.exit_code !== 0
        ? `auto-merge failed (exit ${prWaitJob.exit_code}) — click to view log`
        : ''
  const prWaitAction = prWaitJob ? openJob(prWaitJob) : null

  const steps: PipelineStep[] = []
  if (testJob) {
    steps.push({ label: 'test', state: testState, hint: testHint, action: testAction, jobId: testJob.id })
  }
  if (reviewJob) {
    steps.push({ label: 'review', state: reviewState, hint: reviewHint, action: reviewAction, jobId: reviewJob.id })
  }
  if (fixJob) {
    steps.push({ label: 'fix', state: fixState, hint: fixHint, action: fixAction, jobId: fixJob.id })
  }
  if (commitJob) {
    steps.push({ label: 'commit', state: commitState, hint: commitHint, action: commitAction, jobId: commitJob.id })
  }
  if (pushJob) {
    steps.push({ label: 'push', state: pushState, hint: pushHint, action: pushAction, retryAction: pushRetryAction, jobId: pushJob.id })
  }
  if (showPrChip) {
    steps.push({ label: 'pr', state: prState, hint: prHint, action: prAction, jobId: pushJob?.id ?? null })
  }
  if (dodJob) {
    steps.push({ label: 'dod', state: dodState, hint: dodHint, action: dodAction, jobId: dodJob.id })
  }
  if (prWaitJob) {
    steps.push({ label: 'merge', state: prWaitState, hint: prWaitHint, action: prWaitAction, jobId: prWaitJob.id })
  }
  if (soakJob) {
    const soakState = stateOf(soakJob)
    const soakHint = soakJob.status === 'running'
      ? 'watching default-branch CI on the merge commit — click to open terminal'
      : soakJob.exit_code === 0
        ? 'soak completed — no failures observed'
        : 'soak detected post-merge failures and opened a revert PR — click to view log'
    steps.push({ label: 'soak', state: soakState, hint: soakHint, action: openJob(soakJob), jobId: soakJob.id })
  }

  const runningStepIdx = steps.findIndex(s => s.state === 'running')
  const doneCount = steps.filter(s => s.state === 'done').length
  const totalSteps = steps.length
  const activeStep = runningStepIdx >= 0 ? steps[runningStepIdx] : null
  const attentionStep = steps.find(s => s.state === 'failed' || s.state === 'warning')
  // Tone the leading "PIPELINE" word by the most salient state, but don't
  // restate "<kind> <state>" — the matching pill already shows that. The
  // trailing "x/y" counter on the right is the only summary number we need.
  const summaryStep = activeStep ?? attentionStep
  const summaryTone = summaryStep?.state === 'failed'
    ? 'text-status-error'
    : summaryStep?.state === 'warning'
      ? 'text-status-warning'
      : summaryStep?.state === 'running'
        ? 'text-accent'
        : 'text-text-tertiary'
  const summaryText = summaryLabel(summaryStep ?? null, doneCount, totalSteps)
  const stripVisible = !!activeReleaseJob || runningStepKinds.size > 0
  const canAbortRelease = !!activeReleaseJob
  const summaryHint = summaryHintText(activeStep?.hint ?? attentionStep?.hint ?? 'Pipeline running')
  const firstWindowJob = windowJobs[0]
  const firstStep = steps[0] ?? (firstWindowJob
    ? {
        label: jobKindLabel(firstWindowJob.kind),
        state: stateOf(firstWindowJob),
        hint: `${jobKindLabel(firstWindowJob.kind)} started the visible pipeline`,
        action: openJob(firstWindowJob),
        jobId: firstWindowJob.id,
      }
    : {
        label: jobKindLabel(displayReleaseJob.kind),
        state: stateOf(displayReleaseJob),
        hint: `${jobKindLabel(displayReleaseJob.kind)} started the release`,
        action: openJob(displayReleaseJob),
        jobId: displayReleaseJob.id,
      })
  const nextPendingStep = steps.find(s => s.state === 'pending')
  const currentStep = activeStep ?? attentionStep ?? nextPendingStep ?? steps[steps.length - 1] ?? firstStep
  const expectedGoal: PipelineStep = (() => {
    const existingGoal = prWaitJob
      ? { label: 'merge', state: prWaitState, hint: prWaitHint, action: prWaitAction, jobId: prWaitJob.id }
      : pushJob && pushState === 'failed'
          ? { label: 'push', state: pushState, hint: pushHint, action: pushAction, retryAction: pushRetryAction, jobId: pushJob.id }
        : showPrChip
          ? { label: 'pr', state: prState, hint: prHint, action: prAction, jobId: pushJob?.id ?? null }
        : dodJob
          ? { label: 'dod', state: dodState, hint: dodHint, action: dodAction, jobId: dodJob.id }
        : pushJob
            ? { label: 'push', state: pushState, hint: pushHint, action: pushAction, retryAction: pushRetryAction, jobId: pushJob.id }
            : commitJob
              ? { label: 'commit', state: commitState, hint: commitHint, action: commitAction, jobId: commitJob.id }
              : null
    if (existingGoal) return existingGoal
    if (!onDefaultBranch && autoPush) {
      return {
        label: 'merge',
        state: 'pending',
        hint: 'target: open or reuse a PR, wait for CI, then merge',
        action: null,
        jobId: null,
      }
    }
    if (autoPush || unpushedBool || hasChanges) {
      return {
        label: 'push',
        state: 'pending',
        hint: onDefaultBranch ? 'target: push directly to the default branch' : 'target: publish the reviewed changes',
        action: null,
        jobId: null,
      }
    }
    return {
      label: currentStep.label,
      state: currentStep.state,
      hint: currentStep.hint,
      action: currentStep.action,
      retryAction: currentStep.retryAction,
      jobId: currentStep.jobId,
    }
  })()
  const journeySteps: PipelineJourneyStep[] = [
    toJourneyStep(firstStep, 'start', 'initial run'),
    toJourneyStep(currentStep, 'now', currentStep.state === 'pending' ? 'pending step' : `${stateLabel(currentStep.state)} step`),
    toJourneyStep(expectedGoal, 'goal', 'target'),
  ]

  if (!stripVisible) return null

  return (
    <div className="mt-3 mb-3 rounded-md border border-border bg-bg-secondary px-3 py-2.5">
      <div className="flex items-center gap-x-2 gap-y-2 flex-wrap">
      <div
        className={`flex min-w-[170px] items-center gap-2 rounded-md border px-2.5 py-2 shrink-0 ${stepChipClass(summaryStep?.state ?? 'pending', !!activeStep)}`}
        aria-label={`pipeline summary: ${summaryText}`}
        title={summaryHint}
      >
        <span className="inline-flex items-center justify-center w-3.5 h-3.5 shrink-0">
          {stepIcon(summaryStep?.state ?? 'pending')}
        </span>
        <div className="min-w-0 flex-1 leading-none">
          <span className={`text-[9px] uppercase tracking-[0.18em] ${summaryTone}`}>pipeline</span>
          <div className="mt-1 flex items-center gap-2">
            <span className="truncate text-[11px] font-medium text-text-primary">{summaryText}</span>
            <span className={`truncate text-[10px] ${stateTextClass(summaryStep?.state ?? 'pending')}`}>
              {summaryHint}
            </span>
          </div>
        </div>
        <span
          className="ml-1 rounded-sm bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-current/85"
          title={`${doneCount} of ${totalSteps} steps complete`}
        >
          {doneCount}/{totalSteps}
        </span>
      </div>
      {journeySteps.map((s, i) => {
        const clickable = !!s.action
        const isCurrent = s.role === 'now' && s.state === 'running'
        const label = visibleStateLabel(s.state)
        const chipClass = `inline-flex min-h-[44px] min-w-[112px] items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors ${stepChipClass(s.state, isCurrent)} ${s.role === 'now' ? 'font-semibold' : ''}`
        const chip = (
          <>
            <span className="inline-flex items-center justify-center w-3.5 h-3.5 shrink-0">
              {stepIcon(s.state)}
            </span>
            <div className="flex min-w-0 flex-col items-start leading-none">
              <div className="flex w-full min-w-0 items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-tertiary">{s.role}</span>
                <span className={`rounded-sm border px-1 py-0.5 font-sans text-[8px] font-medium uppercase tracking-[0.10em] ${stateBadgeClass(s.state)}`}>
                  {label}
                </span>
              </div>
              <span className="mt-1 truncate font-sans text-[12px] font-medium text-text-primary">{s.label}</span>
              <span className="mt-1 truncate font-sans text-[10px] text-text-tertiary">{s.meta}</span>
            </div>
          </>
        )
        return (
          <div key={`${s.role}:${s.label}:${s.jobId ?? 'synthetic'}`} className="flex items-center gap-1">
            {clickable ? (
              <button
                type="button"
                className={`${chipClass} cursor-pointer hover:brightness-110`}
                onClick={s.action!}
                aria-label={`${s.label}: ${stateLabel(s.state)}. ${s.hint}`}
                title={s.hint}
              >{chip}</button>
            ) : (
              <div
                className={chipClass}
                title={s.hint}
                role="group"
                aria-label={`${s.label}: ${stateLabel(s.state)}. ${s.hint}`}
              >
                {chip}
              </div>
            )}
            {s.retryAction && (
              <button
                type="button"
                className="inline-flex w-[22px] items-center justify-center rounded border border-status-error/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-status-error hover:bg-status-error/10 cursor-pointer disabled:opacity-50"
                onClick={s.retryAction}
                disabled={retryingPush || jobsPaused}
                title={jobsPaused ? 'Jobs are paused globally. Resume jobs to start a push.' : 'Retry push'}
              >
                {retryingPush
                  ? <Spinner size="xs" />
                  : '↻'}
              </button>
            )}
            {i < journeySteps.length - 1 && (
              <span className={`h-0.5 w-4 rounded-full ${connectorClass(s.state)} transition-colors`} aria-hidden />
            )}
          </div>
        )
      })}
      {traceReleaseId && (
        <Link
          href={`/project/${encodeURIComponent(projectName)}/release/${encodeURIComponent(traceReleaseId)}`}
          className="ml-auto text-[10px] text-accent hover:underline font-mono shrink-0"
          title="View unified release trace"
        >
          trace →
        </Link>
      )}
      {canAbortRelease && (
        confirmAbort ? (
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[10px] font-mono text-text-tertiary">abort?</span>
            <button
              type="button"
              className="text-[10px] font-mono leading-none px-1.5 py-0.5 rounded text-status-error border border-status-error/40 hover:bg-status-error/15 cursor-pointer transition-colors inline-flex items-center justify-center min-w-[28px]"
              onClick={handleAbortPipeline}
              disabled={aborting}
              title="Confirm abort"
            >{aborting
              ? <Spinner size="xs" />
              : 'yes'
            }</button>
            <button
              type="button"
              className="text-[10px] font-mono leading-none px-1.5 py-0.5 rounded text-text-tertiary border border-border/50 hover:bg-bg-tertiary cursor-pointer transition-colors"
              onClick={() => setConfirmAbort(false)}
            >no</button>
          </div>
        ) : (
          <button
            type="button"
            className="text-[10px] font-mono leading-none shrink-0 px-1.5 py-0.5 rounded text-text-tertiary hover:text-status-error hover:bg-status-error/10 cursor-pointer disabled:opacity-50 transition-colors"
            onClick={handleAbortPipeline}
            disabled={aborting}
            title="Abort the running pipeline"
          >
            abort
          </button>
        )
      )}
      </div>
    </div>
  )
}
