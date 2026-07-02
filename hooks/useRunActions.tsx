'use client'

import { Fragment, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  releaseProject,
  pushProject,
  continueJob,
  retryAutomationQueue,
  cancelAutomationQueueItem,
} from '@/lib/client-api'
import type { AutomationQueueItem } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'
import { PIPELINE_CHILD_KINDS } from '@/components/project-runs/release-groups'
import type { Entry } from '@/components/project-runs/types'

interface UseRunActionsArgs {
  projectName: string
  jobsPaused: boolean
  latestTopLevelReleaseKey: string | null
  loadJobs: () => Promise<unknown>
  loadQueue: () => Promise<unknown>
  setQueueItems: Dispatch<SetStateAction<AutomationQueueItem[]>>
  setExpanded: Dispatch<SetStateAction<Set<string>>>
}

interface UseRunActionsResult {
  releaseActionsFor: (e: Entry) => React.ReactNode
  queueActionState: { itemId: string; label: string } | null
  retryQueuedWork: (item: AutomationQueueItem) => Promise<void>
  cancelQueuedWork: (item: AutomationQueueItem) => Promise<void>
}

// Owns every per-run action: the Stop / Continue / Rerun / Retry-step /
// Retry-release buttons plus the queued-automation retry/cancel controls.
// The data-loading callbacks it depends on are passed in by the caller.
export function useRunActions({
  projectName,
  jobsPaused,
  latestTopLevelReleaseKey,
  loadJobs,
  loadQueue,
  setQueueItems,
  setExpanded,
}: UseRunActionsArgs): UseRunActionsResult {
  const [releaseActionState, setReleaseActionState] = useState<{ jobId: string; label: string } | null>(null)
  const [stepRetryState, setStepRetryState] = useState<{ jobId: string; label: string } | null>(null)
  const [stopState, setStopState] = useState<{ jobId: string; label: string } | null>(null)
  const [continueState, setContinueState] = useState<{ jobId: string; label: string } | null>(null)
  const [rerunState, setRerunState] = useState<{ jobId: string; label: string } | null>(null)
  const [queueActionState, setQueueActionState] = useState<{ itemId: string; label: string } | null>(null)

  // Reset transient action state when the viewed project changes.
  useEffect(() => {
    setReleaseActionState(null)
    setStepRetryState(null)
    setStopState(null)
    setContinueState(null)
    setRerunState(null)
    setQueueActionState(null)
  }, [projectName])

  // Window after which a --resume against the source job's session is
  // unsafe — model context gets compacted and the system/skills/docs that
  // were only injected on first invocation aren't re-attached. Mirrors
  // MAX_AGE_MS in app/api/jobs/[jobId]/continue/route.ts.
  const CONTINUE_MAX_AGE_MS = 30 * 60 * 1000

  const continueTargetFor = (e: Entry): string | null => {
    if (e.status !== 'done' && e.status !== 'aborted') return null
    if (!e.navSessionId) return null
    if (!(e.kind === 'run' || e.kind.startsWith('agent:'))) return null
    if (e.finishedAt === null) return null
    if (Date.now() - e.finishedAt * 1000 > CONTINUE_MAX_AGE_MS) return null
    // Surface Continue on non-zero exits, OR on clean exits when the outcome
    // classifier flagged the run as unfinished / blocked on a clarifying
    // question (those stop without an error code but still need a prod).
    const failed = e.exitCode === null || e.exitCode !== 0
    const classifierWantsContinue =
      e.outcomeVerdict === 'needs_continue' || e.outcomeVerdict === 'asked_question'
    if (!failed && !classifierWantsContinue) return null
    return e.navJobId
  }

  const continueRun = async (e: Entry) => {
    const targetJobId = continueTargetFor(e)
    if (!targetJobId || jobsPaused) return
    setContinueState({ jobId: targetJobId, label: 'continuing' })
    try {
      await continueJob(targetJobId)
      await loadJobs()
    } catch (error) {
      console.error('[history] continue failed', error)
      setContinueState({ jobId: targetJobId, label: 'failed' })
      setTimeout(() => setContinueState((prev) => (prev?.jobId === targetJobId ? null : prev)), 2500)
      return
    }
    setContinueState(null)
  }

  const rerunTargetFor = (e: Entry): string | null => {
    if (jobsPaused || e.status === 'running' || e.key.startsWith('vgroup:')) return null
    if (!(e.bucket === 'run' || e.bucket === 'agent' || e.bucket === 'other')) return null
    return e.navJobId || null
  }

  const rerunRun = async (e: Entry) => {
    const targetJobId = rerunTargetFor(e)
    if (!targetJobId) return
    setRerunState({ jobId: targetJobId, label: 'rerunning' })
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(targetJobId)}/rerun`, { method: 'POST' })
      const body = await res.json().catch(() => ({})) as { detail?: string }
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`)
      await loadJobs()
    } catch (error) {
      console.error('[history] rerun failed', error)
      setRerunState({ jobId: targetJobId, label: 'failed' })
      setTimeout(() => setRerunState((prev) => (prev?.jobId === targetJobId ? null : prev)), 2500)
      return
    }
    setRerunState(null)
  }

  const stopTargetFor = (e: Entry): { jobId: string; mode: 'job' | 'release' } | null => {
    if (e.key.startsWith('vgroup:')) return null
    if (e.kind === 'release' && e.status === 'running') return { jobId: e.navJobId, mode: 'release' }
    if (e.releaseOutcome?.status === 'running') {
      return { jobId: e.releaseOutcome.releaseJobId, mode: 'release' }
    }
    if (e.status === 'running' && e.releaseId && PIPELINE_CHILD_KINDS.has(e.kind)) {
      return { jobId: e.releaseId, mode: 'release' }
    }
    if (e.status === 'running') return { jobId: e.navJobId, mode: 'job' }
    return null
  }

  const stopRun = async (e: Entry) => {
    const target = stopTargetFor(e)
    if (!target) return
    const { jobId } = target
    setStopState({ jobId, label: 'stopping' })
    try {
      const res = target.mode === 'release'
        ? await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/release/abort`, { method: 'POST' })
        : await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
      const body = await res.json().catch(() => ({})) as { status?: string; detail?: string }
      const abortPending = target.mode === 'release' && body.status === 'abort_pending'
      if (!res.ok && !abortPending) {
        throw new Error(body?.detail || `HTTP ${res.status}`)
      }
      setStopState({ jobId, label: abortPending ? 'abort pending' : 'stopped' })
      setTimeout(() => setStopState((prev) => (prev?.jobId === jobId ? null : prev)), abortPending ? 2500 : 1500)
      await loadJobs()
    } catch (error) {
      console.error('[history] stop failed', error)
      setStopState({ jobId, label: 'failed' })
      setTimeout(() => setStopState((prev) => (prev?.jobId === jobId ? null : prev)), 2500)
    }
  }

  const retryQueuedWork = async (item: AutomationQueueItem) => {
    if (!item.retryAllowed) return
    setQueueActionState({ itemId: item.id, label: 'retrying' })
    try {
      const result = await retryAutomationQueue(item.project)
      setQueueItems(result.items)
      await loadJobs()
      setQueueActionState(null)
    } catch (error) {
      console.error('[history] queue retry failed', error)
      setQueueActionState({ itemId: item.id, label: 'failed' })
      setTimeout(() => setQueueActionState((prev) => (prev?.itemId === item.id ? null : prev)), 2500)
    }
  }

  const cancelQueuedWork = async (item: AutomationQueueItem) => {
    if (!item.cancelAllowed) return
    setQueueActionState({ itemId: item.id, label: 'cancelling' })
    try {
      await cancelAutomationQueueItem(item)
      await loadQueue()
      setQueueActionState(null)
    } catch (error) {
      console.error('[history] queue cancel failed', error)
      setQueueActionState({ itemId: item.id, label: 'failed' })
      setTimeout(() => setQueueActionState((prev) => (prev?.itemId === item.id ? null : prev)), 2500)
    }
  }

  const retryRelease = async (source: Entry) => {
    if (jobsPaused) return
    setReleaseActionState({ jobId: source.navJobId, label: 'starting' })
    try {
      const result = await releaseProject(projectName, { queueIfBlocked: true, sourceJobId: source.navJobId })
      await loadJobs()
      if (result.release_job_id) {
        setExpanded((prev) => new Set(prev).add(source.key))
      }
    } catch (error) {
      console.error('[history] release retry failed', error)
      setReleaseActionState({ jobId: source.navJobId, label: 'failed' })
      setTimeout(() => setReleaseActionState(null), 2500)
      return
    }
    setReleaseActionState(null)
  }

  const failedRetryableStep = (release: Entry): Entry | null => {
    if (
      release.status === 'running'
      || release.finishedAt === null
      || release.exitCode === null
      || release.exitCode === 0
    ) {
      return null
    }
    const failed = (release.children ?? [])
      .filter((child) => child.status === 'done' && child.exitCode !== null && child.exitCode !== 0)
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    return failed && (failed.kind === 'commit' || failed.kind === 'push') ? failed : null
  }

  const retryPipelineStep = async (release: Entry, step: Entry) => {
    if (jobsPaused) return
    setStepRetryState({ jobId: step.navJobId, label: 'retrying' })
    try {
      if (step.kind === 'commit') {
        await pushProject(projectName, { commit: true, releaseId: release.navJobId ?? null })
      } else if (step.kind === 'push') {
        await pushProject(projectName, { releaseId: release.navJobId ?? null })
      }
      await loadJobs()
      setExpanded((prev) => new Set(prev).add(release.key))
    } catch (error) {
      console.error('[history] step retry failed', error)
      setStepRetryState({ jobId: step.navJobId, label: 'failed' })
      setTimeout(() => setStepRetryState(null), 2500)
      return
    }
    setStepRetryState(null)
  }

  const releaseActionsFor = (e: Entry): React.ReactNode => {
    // The "release" is no longer a separate row: an agent that triggered a
    // release carries that release's actions on its own row. `releaseTarget`
    // is the entry whose navJobId / failed-step we attribute buttons to —
    // the release itself when `e` is a release row, otherwise the agent's
    // owned release (so the agent row gets Retry/Continue release).
    const ownedRelease = e.kind !== 'release'
      ? e.chainedChildren?.find((c) => c.kind === 'release') ?? null
      : null
    const releaseTarget: Entry = e.kind === 'release' ? e : (ownedRelease ?? e)
    const outcomeStatus = e.releaseOutcome?.status
      ?? (releaseTarget.kind === 'release' && (releaseTarget.status === 'done' || releaseTarget.status === 'aborted') && releaseTarget.exitCode !== null && releaseTarget.exitCode !== 0
        ? (releaseTarget.children?.length ?? 0) === 0 ? 'blocked' : 'failed'
        : null)
    // Only the latest release for the project should offer continue/retry —
    // older failed releases reflect a past project state, and retrying them
    // would silently rerun on whatever's currently checked out.
    const isLatestRelease = releaseTarget.kind === 'release' && releaseTarget.key === latestTopLevelReleaseKey
    const isRealRelease = releaseTarget.kind === 'release' && !releaseTarget.key.startsWith('vgroup:')
    const retryableStep = isLatestRelease && isRealRelease ? failedRetryableStep(releaseTarget) : null
    const stepRetryButton = retryableStep ? (
      (() => {
        const active = stepRetryState?.jobId === retryableStep.navJobId
        const label = retryableStep.kind === 'push' ? 'Retry push' : 'Retry commit'
        return (
          <Button
            type="button"
            variant="warning"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={jobsPaused || active}
            onClick={() => retryPipelineStep(releaseTarget, retryableStep)}
            title={jobsPaused
              ? 'Jobs are paused globally. Resume jobs to retry this step.'
              : `Retry the failed ${retryableStep.kind} step for this release`}
          >
            {active ? stepRetryState?.label : label}
          </Button>
        )
      })()
    ) : null
    const releaseButton = isLatestRelease && (outcomeStatus === 'blocked' || outcomeStatus === 'failed') ? (
      (() => {
        const active = releaseActionState?.jobId === releaseTarget.navJobId
        const label = active ? releaseActionState.label : outcomeStatus === 'blocked' ? 'Retry release' : 'Continue release'
        const releaseBlocked = jobsPaused || active
        return (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={releaseBlocked}
            onClick={() => retryRelease(releaseTarget)}
            title={jobsPaused
              ? 'Jobs are paused globally. Resume jobs to start a release.'
              : 'Start a new release attempt from the current project state'}
          >
            {label}
          </Button>
        )
      })()
    ) : null
    // Ordinary running jobs are cancelled through the job endpoint. Running
    // releases use the pipeline abort route so the active step is stopped and
    // the pipeline lock is finalized. Agent/run rows may look running only
    // because an attached release is still active; in that case target the
    // release, not the already-finished parent job.
    const stopTarget = stopTargetFor(e)
    const showStop = stopTarget != null
    const stopActive = stopTarget != null && stopState?.jobId === stopTarget.jobId
    const stopButton = showStop ? (
      <Button
        type="button"
        variant="danger"
        size="sm"
        className="h-7 px-2 text-[11px]"
        disabled={stopActive}
        onClick={() => stopRun(e)}
        title="Send SIGTERM and mark this run cancelled"
      >
        {stopActive ? stopState?.label : 'Stop'}
      </Button>
    ) : null
    const continueTargetJobId = continueTargetFor(e)
    const continueButton = continueTargetJobId ? (
      (() => {
        const active = continueState?.jobId === continueTargetJobId
        return (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={jobsPaused || active}
            onClick={() => continueRun(e)}
            title={jobsPaused
              ? 'Jobs are paused globally. Resume jobs to continue this run.'
              : 'Resume the previous CLI session and prod the agent to keep going'}
          >
            {active ? continueState?.label : 'Continue'}
          </Button>
        )
      })()
    ) : null
    const rerunTargetJobId = rerunTargetFor(e)
    const rerunButton = rerunTargetJobId ? (
      (() => {
        const active = rerunState?.jobId === rerunTargetJobId
        return (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={active}
            onClick={() => rerunRun(e)}
            title={jobsPaused ? 'Jobs are paused globally. Resume jobs to rerun this entry.' : 'Start a new run from this entry’s saved prompt'}
          >
            {active ? rerunState?.label : 'Rerun'}
          </Button>
        )
      })()
    ) : null
    const buttonItems: Array<{ key: string; node: React.ReactNode } | null> = [
      stopButton ? { key: 'stop', node: stopButton } : null,
      continueButton ? { key: 'continue', node: continueButton } : null,
      rerunButton ? { key: 'rerun', node: rerunButton } : null,
      stepRetryButton ? { key: `retry-${retryableStep?.kind ?? 'step'}`, node: stepRetryButton } : null,
      releaseButton ? { key: 'release', node: releaseButton } : null,
    ]
    const buttons = buttonItems.filter((button): button is { key: string; node: React.ReactNode } => button !== null)
    if (buttons.length === 0) return null
    if (buttons.length === 1) return buttons[0].node
    return (
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {buttons.map((button) => (
          <Fragment key={button.key}>{button.node}</Fragment>
        ))}
      </div>
    )
  }

  return { releaseActionsFor, queueActionState, retryQueuedWork, cancelQueuedWork }
}
