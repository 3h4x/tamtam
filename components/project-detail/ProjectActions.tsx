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
  creatingPr: boolean

  currentBranch: string | null
  defaultBranch: string | null
  branchCommitsAhead: number | null
  openPrBranches: string[]

  customActions: CustomAction[]
  runningActions: Set<string>

  onFixCi: () => void
  onRelease: () => void
  onCreatePr: () => void
  onTest: () => void
  onCustomAction: (name: string) => void
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
  creatingPr,
  currentBranch,
  defaultBranch,
  branchCommitsAhead,
  openPrBranches,
  customActions,
  runningActions,
  onFixCi,
  onRelease,
  onCreatePr,
  onTest,
  onCustomAction,
}: ProjectActionsProps) {
  // When a release pipeline is in flight it performs its own commit/push git
  // ops. Every OTHER mutating action is gated on `busy` too so an operator
  // can't fire a manual Test/Create-PR mid-release and race it. Manual push/pull
  // are gone entirely — shipping goes through Release; a branch that needs a
  // human (diverged history) surfaces as a HITL inbox signal.
  const busy = releasing || isPipelineRunning
  const BUSY_MSG = 'Release pipeline is running — manual git actions are paused to avoid racing it.'
  const releaseBlocked = jobsPaused || busy
  const fixCiBlocked = jobsPaused || fixingCi || isCiFixRunning
  const testBlocked = jobsPaused || busy || testing || isTestRunning
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
