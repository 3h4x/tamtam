'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/Toast'
import {
  fixCi,
  releaseProject,
  pullProject,
  PullDivergedError,
  testProject,
  pushProject,
  createProjectPR,
  CreatePRPrePushHookError,
} from '@/lib/client-api'
import { buildProjectTerminalPath } from '@/lib/client/project-routes'

interface UseProjectActionsOptions {
  // Guard so the Test action no-ops while a test run is already in flight
  // (mirrors the button's disabled state).
  isTestRunning: boolean
  // Called after a successful pull that changed HEAD — the page resets its
  // behind-count (also driven by a poll effect it owns).
  onBehindReset: () => void
  // Called after a PR is created — the page refreshes its issue/PR summary
  // state (also driven by a poll effect it owns).
  onPrCreated: () => void
}

// Owns the project header's git/pipeline action handlers and their transient
// flags (releasing/testing/pushing/…). Extracted from ProjectDetailPage to keep
// that page under the file-size cap. Handlers are unchanged; cross-cutting state
// the page also polls (behindCount, issue counts) is updated via callbacks so
// this hook stays decoupled from those effects.
export function useProjectActions(
  name: string,
  { isTestRunning, onBehindReset, onPrCreated }: UseProjectActionsOptions,
) {
  const router = useRouter()
  const { toast } = useToast()
  const [fixingCi, setFixingCi] = useState(false)
  const [fixCiResult, setFixCiResult] = useState<string | null>(null)
  const [creatingPr, setCreatingPr] = useState(false)
  const [pushingToPr, setPushingToPr] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pullResult, setPullResult] = useState<string | null>(null)
  const [pullDiverged, setPullDiverged] = useState(false)

  const handlePull = async (strategy: 'ff-only' | 'merge' | 'rebase' = 'ff-only') => {
    if (!name || pulling) return
    setPulling(true)
    setPullResult(null)
    setPullDiverged(false)
    try {
      const res = await pullProject(name, strategy)
      const msg = res.output || 'Already up to date.'
      const alreadyUpToDate = msg.includes('Already up to date')
      setPullResult(alreadyUpToDate ? 'Already up to date.' : 'Pulled.')
      if (!alreadyUpToDate) onBehindReset()
      setTimeout(() => setPullResult(null), 4000)
    } catch (err) {
      if (err instanceof PullDivergedError) {
        setPullDiverged(true)
      } else {
        setPullResult(err instanceof Error ? err.message : 'Pull failed')
        setTimeout(() => setPullResult(null), 6000)
      }
    } finally {
      setPulling(false)
    }
  }

  const handleTest = async () => {
    if (!name || testing || isTestRunning) return
    setTesting(true)
    try {
      const result = await testProject(name)
      router.push(buildProjectTerminalPath(name, { jobId: result.job_id }))
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to start test', 'error')
    } finally {
      setTesting(false)
    }
  }

  const handlePush = async () => {
    if (!name || pushing) return
    setPushing(true)
    try {
      const result = await pushProject(name)
      router.push(buildProjectTerminalPath(name, { jobId: result.job_id }))
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to push', 'error')
    } finally {
      setPushing(false)
    }
  }

  const handleRelease = async () => {
    if (!name || releasing) return
    setReleasing(true)
    try {
      const result = await releaseProject(name)
      toast(`${result.step}: ${result.message}`, 'info')
      const jobIdToOpen = result.release_job_id ?? result.job_id
      if (jobIdToOpen) {
        router.push(buildProjectTerminalPath(name, { jobId: jobIdToOpen }))
      }
    } catch (err) {
      const error = err as Error & { isPipelineLocked?: boolean; blockingJobId?: string }
      if (error.isPipelineLocked) {
        const msg = error.blockingJobId
          ? `Pipeline is running (job ${error.blockingJobId}). Click the job to watch its progress.`
          : (error.message || 'Pipeline is already running. Wait for it to complete before starting another release.')
        toast(msg, 'info')
      } else {
        toast(error instanceof Error ? error.message : 'Failed to start release', 'error')
      }
    } finally {
      setReleasing(false)
    }
  }

  const handlePushToPr = async () => {
    if (!name || pushingToPr) return
    setPushingToPr(true)
    try {
      const result = await pushProject(name, { commit: true })
      router.push(buildProjectTerminalPath(name, { jobId: result.job_id }))
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to push to PR', 'error')
    } finally {
      setPushingToPr(false)
    }
  }

  const runCreatePr = async (opts: { force?: boolean } = {}) => {
    const result = await createProjectPR(name, opts)
    toast(result.url ? `Pull request created: ${result.url}` : 'Pull request created', 'success')
    onPrCreated()
  }

  const handleCreatePr = async () => {
    if (!name || creatingPr) return
    setCreatingPr(true)
    try {
      await runCreatePr()
    } catch (err) {
      // Pre-push hook blocked the push (e.g. repo's local tests/lint failed).
      // Offer the user a one-click force-create that pushes with --no-verify.
      if (err instanceof CreatePRPrePushHookError) {
        const detail = err.message.length > 800 ? err.message.slice(0, 800) + '\n\n…(truncated)' : err.message
        const summary = err.hookFailure === 'pre-push-tests'
          ? "The repo's pre-push tests failed."
          : 'The repo\'s pre-push hook (lint/typecheck) failed.'
        const confirmed = typeof window !== 'undefined' && window.confirm(
          `${summary}\n\n${detail}\n\nForce-create the PR anyway? (pushes with --no-verify, skipping the hook).`,
        )
        if (confirmed) {
          try {
            await runCreatePr({ force: true })
          } catch (forceErr) {
            toast(forceErr instanceof Error ? forceErr.message : 'Failed to force-create PR', 'error')
          }
        } else {
          toast('PR creation cancelled — fix the failing tests/lint, or click Create PR again to force.', 'info')
        }
      } else {
        toast(err instanceof Error ? err.message : 'Failed to create PR', 'error')
      }
    } finally {
      setCreatingPr(false)
    }
  }

  const handleFixCi = async () => {
    if (!name || fixingCi) return
    setFixingCi(true)
    setFixCiResult(null)
    try {
      const result = await fixCi(name)
      router.push(buildProjectTerminalPath(name, { jobId: result.job_id }))
    } catch (err) {
      setFixCiResult(err instanceof Error ? err.message : 'Failed to start CI fix')
      setFixingCi(false)
    }
  }

  return {
    fixingCi,
    fixCiResult,
    creatingPr,
    pushingToPr,
    releasing,
    testing,
    pushing,
    pulling,
    pullResult,
    pullDiverged,
    handlePull,
    handleTest,
    handlePush,
    handleRelease,
    handlePushToPr,
    handleCreatePr,
    handleFixCi,
    dismissDiverged: () => setPullDiverged(false),
  }
}
