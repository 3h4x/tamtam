'use client'

import Link from 'next/link'
import type { CustomAction, ProjectConfig } from '@/lib/client-api'
import { Button, buttonVariants } from '@/components/ui/Button'

export interface ProjectActionsProps {
  projectName: string
  totalChanges: number
  unpushed: number
  aggregateCi: string | null
  ciFailedUrl: string | null
  githubUrl: string | null
  websiteUrl: string | null
  jobsPaused: boolean

  config: ProjectConfig | null
  verdict: string | undefined
  hasUnreviewed: boolean
  isPipelineRunning: boolean
  isTestRunning: boolean
  isCiFixRunning: boolean

  fixingCi: boolean
  fixCiResult: string | null
  releasing: boolean
  testing: boolean
  pushing: boolean
  pulling: boolean
  pullResult: string | null
  pullDiverged: boolean
  behindCount: number
  creatingPr: boolean
  pushingToPr: boolean

  currentBranch: string | null
  defaultBranch: string | null
  branchCommitsAhead: number | null
  openPrBranches: string[]
  openPrByBranch: Record<string, number>

  customActions: CustomAction[]
  runningActions: Set<string>

  onFixCi: () => void
  onRelease: () => void
  onCreatePr: () => void
  onPushToPr: () => void
  onTest: () => void
  onCustomAction: (name: string) => void
  onPush: () => void
  onPull: (strategy?: 'ff-only' | 'merge' | 'rebase') => void
  onDismissDiverged: () => void
}

export function ProjectActions({
  projectName,
  totalChanges,
  unpushed,
  aggregateCi,
  ciFailedUrl,
  githubUrl,
  websiteUrl,
  jobsPaused,
  config,
  verdict,
  hasUnreviewed,
  isPipelineRunning,
  isTestRunning,
  isCiFixRunning,
  fixingCi,
  fixCiResult,
  releasing,
  testing,
  pushing,
  pulling,
  pullResult,
  pullDiverged,
  behindCount,
  creatingPr,
  pushingToPr,
  currentBranch,
  defaultBranch,
  branchCommitsAhead,
  openPrBranches,
  openPrByBranch,
  customActions,
  runningActions,
  onFixCi,
  onRelease,
  onCreatePr,
  onPushToPr,
  onTest,
  onCustomAction,
  onPush,
  onPull,
  onDismissDiverged,
}: ProjectActionsProps) {
  // When a release pipeline is in flight it performs its own commit/push git
  // ops. Every OTHER mutating action is gated on `busy` too so an operator
  // can't fire a manual Test/Push/Pull/Create-PR mid-release and race it.
  const busy = releasing || isPipelineRunning
  const BUSY_MSG = 'Release pipeline is running — manual git actions are paused to avoid racing it.'
  const releaseBlocked = jobsPaused || busy
  const fixCiBlocked = jobsPaused || fixingCi || isCiFixRunning
  const pushToPrBlocked = jobsPaused || busy || pushingToPr
  const testBlocked = jobsPaused || busy || testing || isTestRunning
  const pushBlocked = jobsPaused || busy || pushing
  const nothingToRelease = totalChanges === 0 && (unpushed ?? 0) === 0
  const hasTestCommand = !!(config?.effective_test_command || config?.detected_test_command)
  const freshLgtm = verdict === 'LGTM' && !hasUnreviewed && totalChanges > 0

  const steps: string[] = []
  if (freshLgtm) {
    steps.push('commit', 'push')
  } else if (totalChanges > 0) {
    if (hasTestCommand) steps.push('test')
    steps.push('review', 'commit', 'push')
  } else {
    steps.push('push')
  }
  const multiStep = steps.length > 1
  const chainSuffix = multiStep && !config?.auto_push_enabled && !freshLgtm
    ? ' (enable auto-push in config to auto-chain)'
    : ''

  const isOnFeatureBranch = !!currentBranch && !!defaultBranch && currentBranch !== defaultBranch
  const hasOpenPr = openPrBranches.includes(currentBranch ?? '')
  const showCreatePr = isOnFeatureBranch && !hasOpenPr
  const noCommitsToPr = isOnFeatureBranch && branchCommitsAhead === 0
  const createPrDisabled = jobsPaused || busy || creatingPr || noCommitsToPr
  const createPrTitle = jobsPaused
    ? 'Jobs are paused globally. Resume jobs to create a PR.'
    : busy
    ? BUSY_MSG
    : noCommitsToPr
    ? `Branch ${currentBranch} has no commits ahead of origin/${defaultBranch}. Commit your changes (use Release) or move them to ${defaultBranch} first.`
    : `Create pull request for branch ${currentBranch}`

  const pullPrimaryDisabled = jobsPaused || busy || pulling || totalChanges > 0 || behindCount === 0
  const pullVariant = totalChanges > 0 ? 'secondary' : behindCount > 0 ? 'warning' : 'secondary'

  return (
    <>
      {aggregateCi === 'failure' && ciFailedUrl && (
        <Button
          variant="danger"
          onClick={onFixCi}
          disabled={fixCiBlocked}
          title={
            jobsPaused
              ? 'Jobs are paused globally. Resume jobs to start a CI fix.'
              : isCiFixRunning
                ? 'CI fix already in progress'
                : 'Start CI fix'
          }
        >
          {fixingCi || isCiFixRunning ? 'CI Fix in Progress…' : 'Fix CI'}
        </Button>
      )}
      {fixCiResult && (
        <span className={`text-xs ${fixCiResult.startsWith('CI fix started') ? 'text-status-success' : 'text-status-error'}`}>
          {fixCiResult}
        </span>
      )}
      <Button
        variant="primary"
        onClick={onRelease}
        disabled={releaseBlocked || nothingToRelease}
        title={
          jobsPaused
            ? 'Jobs are paused globally. Resume jobs to start a release.'
            : nothingToRelease
            ? 'Nothing to release — no changes and no unpushed commits'
            : busy
              ? 'Release pipeline already running'
              : freshLgtm
                ? `Ship it — review already LGTM, will commit & push directly (skips test + review)`
                : `Release: ${steps.join(' → ')}${chainSuffix}`
        }
      >
        {busy ? 'Releasing…' : freshLgtm ? 'Ship (LGTM)' : 'Release'}
      </Button>
      {showCreatePr && (
        <Button
          onClick={onCreatePr}
          disabled={createPrDisabled}
          title={createPrTitle}
        >
          {creatingPr ? 'Creating PR…' : 'Create PR'}
        </Button>
      )}
      {hasOpenPr && totalChanges > 0 && (
        <Button
          onClick={onPushToPr}
          disabled={pushToPrBlocked}
          title={
            jobsPaused
              ? 'Jobs are paused globally. Resume jobs to start a push.'
              : busy
              ? BUSY_MSG
              : `Stage ${totalChanges} change${totalChanges === 1 ? '' : 's'}, commit (Claude-generated message), push — attaches to existing PR. Skips test + review (use Release for the full pipeline).`
          }
        >
          {pushingToPr ? 'Pushing…' : `Push to PR${openPrByBranch[currentBranch ?? ''] ? ` #${openPrByBranch[currentBranch ?? '']}` : ''}`}
        </Button>
      )}
      {hasTestCommand && (
        <Button
          onClick={onTest}
          disabled={testBlocked}
          title={
            jobsPaused
              ? 'Jobs are paused globally. Resume jobs to start tests.'
              : busy
              ? BUSY_MSG
              : isTestRunning
                ? 'Tests already running'
                : `Run: ${config?.effective_test_command || config?.detected_test_command}`
          }
        >
          {testing || isTestRunning ? 'Testing…' : 'Test'}
        </Button>
      )}
      {customActions.map((action) => (
        <button
          key={action.name}
          className="btn-custom"
          style={{ '--btn-color': action.color || 'var(--color-accent)' } as React.CSSProperties}
          onClick={() => onCustomAction(action.name)}
          disabled={jobsPaused || busy || runningActions.has(action.name)}
          title={
            jobsPaused
              ? 'Jobs are paused globally. Resume jobs to run this custom action.'
              : busy
              ? BUSY_MSG
              : `Run: ${action.command}`
          }
        >
          {runningActions.has(action.name) ? `${action.name}…` : action.name}
        </button>
      ))}
      <Button
        variant={(unpushed ?? 0) > 0 && totalChanges === 0 ? 'warning' : 'secondary'}
        onClick={onPush}
        disabled={pushBlocked || (unpushed ?? 0) === 0 || totalChanges > 0}
        title={
          jobsPaused
            ? 'Jobs are paused globally. Resume jobs to start a push.'
            : busy
            ? BUSY_MSG
            : totalChanges > 0
              ? `Commit your ${totalChanges} local change${totalChanges !== 1 ? 's' : ''} first (use Release)`
              : (unpushed ?? 0) === 0
                ? 'Nothing to push'
                : `Push ${unpushed} commit${unpushed !== 1 ? 's' : ''} to origin`
        }
      >
        {pushing ? 'Pushing…' : (unpushed ?? 0) > 0 ? `Push (${unpushed})` : 'Push'}
      </Button>
      {pullDiverged ? (
        <span className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-md bg-status-error/10 border border-status-error/40">
          <span className="text-xs text-status-error font-medium">Diverged:</span>
          <Button
            variant="info"
            onClick={() => onPull('rebase')}
            disabled={busy || pulling}
            title={busy ? BUSY_MSG : 'git pull --rebase'}
          >
            {pulling ? 'Working…' : 'Rebase'}
          </Button>
          <Button
            onClick={() => onPull('merge')}
            disabled={busy || pulling}
            title={busy ? BUSY_MSG : 'git pull --no-ff'}
          >
            {pulling ? 'Working…' : 'Merge'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDismissDiverged}
            aria-label="Dismiss diverged warning"
            title="Dismiss"
          >
            ✕
          </Button>
        </span>
      ) : (
        <Button
          variant={pullVariant}
          onClick={() => onPull('ff-only')}
          disabled={pullPrimaryDisabled}
          title={
            jobsPaused
              ? 'Jobs are paused globally. Resume jobs to pull.'
              : busy
              ? BUSY_MSG
              : totalChanges > 0
              ? `Commit or stash your ${totalChanges} local change${totalChanges !== 1 ? 's' : ''} before pulling`
              : behindCount > 0
              ? `${behindCount} commit${behindCount !== 1 ? 's' : ''} behind origin — git pull --ff-only`
              : 'Already up to date'
          }
        >
          {pulling ? 'Pulling…' : behindCount > 0 ? `Pull (${behindCount})` : 'Pull'}
        </Button>
      )}
      {pullResult && (
        <span className={`text-xs ${pullResult.includes('failed') || pullResult.includes('error') ? 'text-status-error' : 'text-status-success'}`}>
          {pullResult}
        </span>
      )}
      {(projectName || githubUrl) && (
        <span className="mx-1 self-center h-5 w-px bg-border/60" aria-hidden="true" />
      )}
      {projectName && (
        <Link
          href={`/pipeline?project=${encodeURIComponent(projectName)}`}
          className={buttonVariants({ variant: 'ghost' })}
          title="View pipeline metrics for this project"
        >
          Pipeline
        </Link>
      )}
      {websiteUrl && (
        <a
          className={buttonVariants({ variant: 'ghost' })}
          href={websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open project website"
        >
          Website
          <span aria-hidden="true" className="text-text-tertiary">↗</span>
        </a>
      )}
      {githubUrl && (
        <a
          className={buttonVariants({ variant: 'ghost' })}
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open repository on GitHub"
        >
          GitHub
          <span aria-hidden="true" className="text-text-tertiary">↗</span>
        </a>
      )}
    </>
  )
}
