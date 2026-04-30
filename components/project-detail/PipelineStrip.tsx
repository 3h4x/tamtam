'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { pushProject } from '@/lib/client-api'
import type { JobInfo, ProjectConfig } from '@/lib/client-api'
import { useToast } from '@/components/Toast'
import { formatAgo } from '@/lib/shared/format'

type StepState = 'pending' | 'running' | 'done' | 'warning' | 'failed' | 'skipped'

interface PipelineStep {
  label: string
  state: StepState
  hint: string
  action?: (() => void) | null
  retryAction?: (() => void) | null
}

export interface PipelineStripProps {
  projectName: string
  projectJobs: JobInfo[]
  config: ProjectConfig | null
  totalChanges: number
  unpushed: number
  hasUnreviewed: boolean
  verdict: string | undefined
  onRefresh: () => Promise<void>
}

function stepChipClass(s: StepState, isRunning: boolean): string {
  if (s === 'done') return 'bg-status-success/12 text-status-success border-status-success/25'
  if (s === 'failed') return 'bg-status-error/15 text-status-error border-status-error/40'
  if (s === 'warning') return 'bg-status-warning/15 text-status-warning border-status-warning/40'
  if (s === 'running') return `bg-accent/15 text-accent border-accent/50 ring-2 ring-accent/25 ${isRunning ? 'shadow-sm' : ''}`
  // 'skipped' is rendered like 'done' but desaturated, so users can see at a
  // glance which steps the release legitimately bypassed (e.g. review skipped
  // because tests passed with no uncommitted changes — the short-circuit path)
  // versus which are truly still pending.
  if (s === 'skipped') return 'bg-bg-tertiary text-text-tertiary border-border/40'
  return 'bg-transparent text-text-tertiary border-border/50'
}

function stepIcon(s: StepState) {
  if (s === 'done') return <span className="text-[10px] leading-none">✓</span>
  if (s === 'failed') return <span className="text-[10px] leading-none">✗</span>
  if (s === 'warning') return <span className="text-[10px] leading-none">!</span>
  if (s === 'running') return <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0" />
  if (s === 'skipped') return <span className="text-[10px] leading-none opacity-70">⤼</span>
  return <span className="text-[10px] leading-none opacity-50">○</span>
}

function connectorClass(prev: StepState): string {
  if (prev === 'done') return 'bg-status-success/40'
  if (prev === 'failed') return 'bg-status-error/40'
  if (prev === 'warning') return 'bg-status-warning/40'
  if (prev === 'running') return 'bg-accent/40'
  if (prev === 'skipped') return 'bg-border/60'
  return 'bg-border/50'
}

export function PipelineStrip({
  projectName,
  projectJobs,
  config,
  totalChanges,
  unpushed,
  hasUnreviewed,
  verdict,
  onRefresh,
}: PipelineStripProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [retryingPush, setRetryingPush] = useState(false)
  const [aborting, setAborting] = useState(false)

  const hasTestCommand = !!(
    config?.effective_test_command ||
    config?.detected_test_command ||
    projectJobs.some(j => j.kind === 'test' && j.started_at >= (Date.now() / 1000 - 60 * 60))
  )

  const pipelineKinds = ['test', 'review', 'fix', 'commit', 'push', 'mark-dod']
  const pipelineRunning = projectJobs.some(
    j => pipelineKinds.includes(j.kind) && j.status === 'running'
  )

  if (!pipelineRunning) return null

  const activeReleaseJob = projectJobs
    .filter(j => j.kind === 'release' && j.status === 'running')
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0]

  const pipelineSequence = ['test', 'review', 'fix', 'commit', 'push', 'mark-dod']
  const runningJob = projectJobs.find(j => pipelineKinds.includes(j.kind) && j.status === 'running')
  const runningIdx = runningJob ? pipelineSequence.indexOf(runningJob.kind) : -1
  const MAX_PIPELINE_DURATION = 30 * 60
  const releaseWindowStart = runningJob ? (runningJob.started_at ?? 0) - MAX_PIPELINE_DURATION : 0

  const latestOfKind = (kind: string): JobInfo | undefined => {
    const idx = pipelineSequence.indexOf(kind)
    if (runningIdx >= 0 && idx > runningIdx) return undefined
    return projectJobs
      .filter(j => j.kind === kind && (j.started_at ?? 0) >= releaseWindowStart)
      .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0]
  }

  const testJob = latestOfKind('test')
  const reviewJob = latestOfKind('review')
  const fixJob = latestOfKind('fix')
  const commitJob = latestOfKind('commit')
  const pushJob = latestOfKind('push')
  const dodJob = latestOfKind('mark-dod')
  const priorPushStart = pushJob?.started_at ?? 0

  const stateOf = (job: JobInfo | undefined): StepState => {
    if (!job) return 'pending'
    if (job.status === 'running') return 'running'
    if (job.exit_code === 0) return 'done'
    return 'failed'
  }

  const testState: StepState = hasTestCommand ? stateOf(testJob) : 'pending'

  const openJob = (j: JobInfo) => {
    const sid = j.session_id
    return () => router.push(sid ? `/project/${projectName}/terminal/${sid}` : `/project/${projectName}/terminal?job=${encodeURIComponent(j.id)}`)
  }

  const reviewRawState = stateOf(reviewJob)
  const reviewVerdict = reviewJob?.verdict
  let reviewState: StepState
  let reviewHint = ''
  let reviewFixAction: (() => void) | null = null

  if (reviewRawState === 'running') {
    reviewState = 'running'
    reviewHint = 'review in progress — click to open terminal'
    reviewFixAction = openJob(reviewJob!)
  } else if (!reviewJob) {
    reviewState = 'pending'
    reviewHint = 'not run yet — click 🚀 Release'
  } else if (reviewRawState === 'failed') {
    reviewState = 'failed'
    reviewHint = `review job failed (exit ${reviewJob.exit_code}) — click to view log`
    reviewFixAction = openJob(reviewJob)
  } else if (reviewVerdict === 'LGTM') {
    const commitHookJustFailed = !!config?.last_push_error && config.last_push_error.startsWith('Commit failed')
    const pushInFlight = pushJob?.status === 'running'
    reviewState = 'done'
    reviewHint = commitHookJustFailed
      ? 'LGTM — commit blocked by pre-commit hook; click to view review'
      : pushInFlight
        ? 'LGTM — commit & push in progress; click to view review'
        : hasUnreviewed
          ? 'LGTM — files changed since, but verdict is still valid; click to view review'
          : 'LGTM — click to view review log'
    reviewFixAction = openJob(reviewJob)
  } else if (reviewVerdict === 'NEEDS ATTENTION') {
    reviewState = 'warning'
    reviewHint = 'verdict: NEEDS ATTENTION — click to view findings'
    reviewFixAction = openJob(reviewJob)
  } else {
    reviewState = 'failed'
    reviewHint = `verdict: ${reviewVerdict || 'unknown'} — click to view findings`
    reviewFixAction = openJob(reviewJob)
  }

  if ((reviewState === 'failed' || reviewState === 'warning') && fixJob && fixJob.status === 'running') {
    reviewState = 'running'
    reviewHint = 'fix in progress — click to open terminal'
    reviewFixAction = openJob(fixJob)
  }
  const reviewPassed = reviewState === 'done'

  const fixState: StepState = fixJob?.status === 'running' ? 'running'
    : fixJob && fixJob.exit_code === 0 ? 'done'
    : fixJob && fixJob.exit_code !== 0 ? 'failed'
    : reviewState === 'done' ? 'done'
    : 'pending'
  const fixHint = fixJob?.status === 'running' ? 'fix in progress — click to open terminal'
    : fixJob?.exit_code === 0 ? 'fix applied — click to view log'
    : fixJob && fixJob.exit_code !== 0 ? `fix failed (exit ${fixJob.exit_code}) — click to view log`
    : reviewState === 'done' ? 'no fix needed (LGTM)'
    : 'waiting for review verdict'
  const fixAction = fixJob ? openJob(fixJob) : null

  const dodState: StepState = stateOf(dodJob)
  const dodHint = dodJob?.status === 'running' ? 'DoD verification in progress — click to open terminal'
    : dodJob?.exit_code === 0 ? 'DoD verified — click to view log'
    : dodJob && dodJob.exit_code !== 0 ? 'DoD verification failed — click to view log'
    : reviewPassed ? 'waiting for push'
    : 'waiting for LGTM review'
  const dodAction = dodJob ? openJob(dodJob) : null

  const hasChanges = totalChanges > 0
  const unpushedBool = unpushed > 0
  const autoPush = !!config?.auto_push_enabled
  const pushError = config?.last_push_error ?? null
  const pipelineEpoch = Math.max(
    testJob?.started_at ?? 0,
    reviewJob?.started_at ?? 0,
    fixJob?.started_at ?? 0,
  )
  const effectivePushError = pipelineEpoch > priorPushStart ? null : pushError
  const pushErrorIsCommit = !!effectivePushError && effectivePushError.startsWith('Commit failed')

  const commitRunning = commitJob?.status === 'running'
  const commitStateEffective: StepState = commitRunning
    ? 'running'
    : commitJob?.exit_code === 0 ? 'done'
    : commitJob && commitJob.exit_code !== 0 ? 'failed'
    : pushErrorIsCommit ? 'failed'
    : hasChanges ? 'pending' : 'done'

  const pushRunning = pushJob?.status === 'running'
  const pushStateEffective: StepState = pushRunning
    ? 'running'
    : pushJob?.exit_code === 0 ? 'done'
    : pushJob && pushJob.exit_code !== 0 ? 'failed'
    : effectivePushError && !pushErrorIsCommit ? 'failed'
    : !hasChanges && !unpushedBool ? 'done' : 'pending'

  const testHint = !hasTestCommand
    ? 'no test command'
    : testState === 'running' ? 'tests running'
    : testState === 'done' && testJob ? `tests passed (${formatAgo(testJob.finished_at ?? testJob.started_at)})`
    : testState === 'failed' ? `tests failed (exit ${testJob?.exit_code})`
    : 'tests not run yet'

  const pushHint = pushStateEffective === 'failed'
    ? (effectivePushError ?? 'push failed')
    : pushStateEffective === 'done'
      ? 'nothing to push'
      : unpushedBool
        ? `${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}${autoPush && reviewPassed ? ' — auto-push pending' : ''}`
        : `${totalChanges} uncommitted change${totalChanges === 1 ? '' : 's'} — need review & commit first`

  const commitHint = commitStateEffective === 'failed'
    ? (commitJob ? `commit failed (exit ${commitJob.exit_code}) — click to view log` : (effectivePushError ?? 'commit failed'))
    : commitStateEffective === 'done'
      ? 'nothing to commit'
      : commitStateEffective === 'running'
        ? 'commit in progress — click to open terminal'
        : reviewPassed
          ? `${totalChanges} uncommitted change${totalChanges === 1 ? '' : 's'} — ${autoPush ? 'auto-commit pending' : 'commit manually'}`
          : `${totalChanges} uncommitted change${totalChanges === 1 ? '' : 's'} — need LGTM review to proceed`

  const openCommitJob = commitJob ? () => router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(commitJob.id)}`) : null
  const openPushJob = pushJob ? () => router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(pushJob.id)}`) : null

  const handleRetryPush = async () => {
    if (retryingPush) return
    setRetryingPush(true)
    try {
      const result = await pushProject(projectName)
      if (result.job_id) {
        router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(result.job_id)}`)
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
    if (!confirm('Abort the running pipeline? The current step will be killed and no further steps will run.')) return
    setAborting(true)
    try {
      const res = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/release/abort`, { method: 'POST' })
      const data = await res.json() as { status: string }
      if (data.status === 'aborted') {
        toast('Pipeline aborted', 'success')
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

  // Detect the "tests passed, nothing to commit" short-circuit: in that case
  // the release skips review/fix/commit and goes straight to push. Steps that
  // never ran but were bypassed-by-design get a distinct 'skipped' state so
  // the user doesn't read them as "still to do" or "stuck".
  // The conditions: tests succeeded for this release window AND there are no
  // uncommitted changes AND no review job exists for this run AND push has
  // either started or finished — that combination only happens on the
  // short-circuit path (job-storage's testCompletedHook).
  const shortCircuited =
    testState === 'done' &&
    !hasChanges &&
    !reviewJob &&
    !!pushJob

  const reviewStateFinal: StepState = shortCircuited && reviewState === 'pending' ? 'skipped' : reviewState
  const reviewHintFinal = shortCircuited && reviewState === 'pending'
    ? 'skipped — tests passed and there are no uncommitted changes (short-circuit to push)'
    : reviewHint
  const fixStateFinal: StepState = shortCircuited && fixState === 'pending' ? 'skipped' : fixState
  const fixHintFinal = shortCircuited && fixState === 'pending'
    ? 'skipped — review was bypassed, no fix needed'
    : fixHint
  const commitStateFinal: StepState = shortCircuited && !commitJob ? 'skipped' : commitStateEffective
  const commitHintFinal = shortCircuited && !commitJob
    ? 'skipped — nothing to commit, release pushed existing commits'
    : commitHint

  const steps: PipelineStep[] = []
  if (hasTestCommand) steps.push({ label: 'test', state: testState, hint: testHint, action: testJob ? () => router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(testJob.id)}`) : null })
  steps.push({ label: 'review', state: reviewStateFinal, hint: reviewHintFinal, action: reviewFixAction })
  steps.push({ label: 'fix', state: fixStateFinal, hint: fixHintFinal, action: fixAction })
  steps.push({ label: 'commit', state: commitStateFinal, hint: commitHintFinal, action: openCommitJob })
  steps.push({ label: 'push', state: pushStateEffective, hint: pushHint, action: openPushJob, retryAction: pushStateEffective === 'failed' && !pushErrorIsCommit ? handleRetryPush : null })
  if (config?.auto_pr_merge_enabled) {
    steps.push({ label: 'dod', state: dodState, hint: dodHint, action: dodAction })
    steps.push({ label: 'merge', state: 'pending', hint: 'auto-merge after CI passes', action: null })
  }

  const runningStepIdx = steps.findIndex(s => s.state === 'running')
  const doneCount = steps.filter(s => s.state === 'done').length
  const totalSteps = steps.length

  // suppress unused warning - verdict is available for future use
  void verdict

  return (
    <div className="mt-3 mb-3 px-3 py-2 rounded-md border border-border bg-bg-secondary flex items-center gap-1 flex-wrap">
      {steps.map((s, i) => {
        const clickable = !!s.action
        const dimmed = s.state === 'pending' && runningStepIdx >= 0 && i > runningStepIdx
        const isCurrent = i === runningStepIdx
        const chipClass = `inline-flex items-center gap-1.5 px-2 py-1 rounded-md border font-mono text-[11px] font-medium transition-colors ${stepChipClass(s.state, isCurrent)} ${dimmed ? 'opacity-35' : ''} ${isCurrent ? 'font-semibold' : ''}`
        const chip = (
          <>
            {stepIcon(s.state)}
            <span>{s.label}</span>
          </>
        )
        return (
          <div key={s.label} className="flex items-center gap-1">
            {clickable ? (
              <button
                type="button"
                className={`${chipClass} cursor-pointer hover:brightness-110`}
                onClick={s.action!}
                title={s.hint}
              >{chip}</button>
            ) : (
              <div className={chipClass} title={s.hint}>{chip}</div>
            )}
            {s.retryAction && (
              <button
                type="button"
                className="text-[10px] px-1.5 py-0.5 rounded border border-status-error/40 text-status-error hover:bg-status-error/10 cursor-pointer disabled:opacity-50 font-mono leading-none"
                onClick={s.retryAction}
                disabled={retryingPush}
                title="Retry push"
              >
                {retryingPush ? '…' : '↻'}
              </button>
            )}
            {i < steps.length - 1 && (
              <span className={`h-px w-3 ${connectorClass(s.state)} transition-colors`} aria-hidden />
            )}
          </div>
        )
      })}
      <span className="ml-2 text-[10px] font-mono text-text-tertiary tabular-nums shrink-0" title={`${doneCount} of ${totalSteps} steps complete`}>
        {doneCount}/{totalSteps}
      </span>
      {activeReleaseJob && (
        <Link
          href={`/project/${encodeURIComponent(projectName)}/release/${encodeURIComponent(activeReleaseJob.id)}`}
          className="ml-auto text-[10px] text-accent hover:underline font-mono shrink-0"
          title="View unified release trace"
        >
          trace →
        </Link>
      )}
      <button
        type="button"
        className={`text-[10px] font-mono leading-none shrink-0 px-1.5 py-0.5 rounded text-text-tertiary hover:text-status-error hover:bg-status-error/10 cursor-pointer disabled:opacity-50 transition-colors ${activeReleaseJob ? '' : 'ml-auto'}`}
        onClick={handleAbortPipeline}
        disabled={aborting}
        title="Abort the running pipeline"
      >
        {aborting ? '…' : 'abort'}
      </button>
    </div>
  )
}
