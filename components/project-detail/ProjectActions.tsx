'use client'

import Link from 'next/link'
import type { CustomAction, ProjectConfig } from '@/lib/client-api'

export interface ProjectActionsProps {
  projectName: string
  totalChanges: number
  unpushed: number
  aggregateCi: string | null
  ciFailedUrl: string | null
  githubUrl: string | null

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
  const busy = releasing || isPipelineRunning
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
  const createPrDisabled = creatingPr || noCommitsToPr
  const createPrTitle = noCommitsToPr
    ? `Branch ${currentBranch} has no commits ahead of origin/${defaultBranch}. Commit your changes (use 🚀 Release) or move them to ${defaultBranch} first.`
    : `Create pull request for branch ${currentBranch}`

  return (
    <>
      {aggregateCi === 'failure' && ciFailedUrl && (
        <button
          className="px-3 py-1.5 text-sm border border-status-error text-status-error rounded-md hover:bg-status-error/10 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onFixCi}
          disabled={fixingCi || isCiFixRunning}
          title={isCiFixRunning ? 'CI fix already in progress' : 'Start CI fix'}
        >
          {fixingCi || isCiFixRunning ? 'CI Fix in Progress...' : 'Fix CI'}
        </button>
      )}
      {fixCiResult && (
        <span className={`text-xs ${fixCiResult.startsWith('CI fix started') ? 'text-status-success' : 'text-status-error'}`}>
          {fixCiResult}
        </span>
      )}
      <button
        className="px-3 py-1.5 text-sm border border-accent bg-accent/10 text-accent rounded-md hover:bg-accent/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        onClick={onRelease}
        disabled={busy || nothingToRelease}
        title={
          nothingToRelease
            ? 'Nothing to release — no changes and no unpushed commits'
            : busy
              ? 'Release pipeline already running'
              : freshLgtm
                ? `Ship it — review already LGTM, will commit & push directly (skips test + review)`
                : `Release: ${steps.join(' → ')}${chainSuffix}`
        }
      >
        {busy ? 'Releasing…' : freshLgtm ? '🚢 Ship (LGTM)' : '🚀 Release'}
      </button>
      {showCreatePr && (
        <button
          className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          onClick={onCreatePr}
          disabled={createPrDisabled}
          title={createPrTitle}
        >
          {creatingPr ? 'Creating PR…' : 'Create PR'}
        </button>
      )}
      {hasOpenPr && totalChanges > 0 && (
        <button
          className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          onClick={onPushToPr}
          disabled={pushingToPr}
          title={`Stage ${totalChanges} change${totalChanges === 1 ? '' : 's'}, commit (Claude-generated message), push — attaches to existing PR. Skips test + review (use Release for the full pipeline).`}
        >
          {pushingToPr ? 'Pushing…' : `Push to PR${openPrByBranch[currentBranch ?? ''] ? ` #${openPrByBranch[currentBranch ?? '']}` : ''}`}
        </button>
      )}
      {!!(config?.effective_test_command || config?.detected_test_command) && (
        <button
          className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          onClick={onTest}
          disabled={testing || isTestRunning}
          title={isTestRunning ? 'Tests already running' : `Run: ${config?.effective_test_command || config?.detected_test_command}`}
        >
          {testing || isTestRunning ? 'Testing…' : 'Test'}
        </button>
      )}
      {customActions.map((action) => (
        <button
          key={action.name}
          className="btn-custom"
          style={{ '--btn-color': action.color || 'var(--color-accent)' } as React.CSSProperties}
          onClick={() => onCustomAction(action.name)}
          disabled={runningActions.has(action.name)}
          title={`Run: ${action.command}`}
        >
          {runningActions.has(action.name) ? `${action.name}...` : action.name}
        </button>
      ))}
      {(unpushed ?? 0) > 0 && totalChanges === 0 && (
        <button
          className="px-3 py-1.5 text-sm border border-status-warning/60 bg-status-warning/10 text-status-warning rounded-md hover:bg-status-warning/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          onClick={onPush}
          disabled={pushing}
          title={`Push ${unpushed} commit${unpushed !== 1 ? 's' : ''} to origin`}
        >
          {pushing ? 'Pushing…' : `Push (${unpushed})`}
        </button>
      )}
      {pullDiverged ? (
        <>
          <span className="text-xs text-status-error font-medium">Diverged:</span>
          <button
            className="px-3 py-1.5 text-sm border border-status-info/50 bg-status-info/10 text-status-info rounded-md hover:bg-status-info/20 cursor-pointer disabled:opacity-50 font-medium"
            onClick={() => onPull('rebase')}
            disabled={pulling}
            title="git pull --rebase"
          >
            {pulling ? 'Working…' : 'Rebase'}
          </button>
          <button
            className="px-3 py-1.5 text-sm border border-border bg-bg-secondary text-text-primary rounded-md hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 font-medium"
            onClick={() => onPull('merge')}
            disabled={pulling}
            title="git pull --no-ff"
          >
            {pulling ? 'Working…' : 'Merge'}
          </button>
          <button
            className="px-2 py-1 text-xs text-text-tertiary hover:text-text-secondary cursor-pointer"
            onClick={onDismissDiverged}
          >✕</button>
        </>
      ) : (
        <button
          className={`px-3 py-1.5 text-sm border rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            totalChanges > 0
              ? 'border-border bg-bg-secondary text-text-primary cursor-not-allowed'
              : behindCount > 0
              ? 'border-status-warning/60 bg-status-warning/10 text-status-warning hover:bg-status-warning/20 cursor-pointer'
              : 'border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer'
          }`}
          onClick={() => onPull('ff-only')}
          disabled={pulling || totalChanges > 0 || behindCount === 0}
          title={
            totalChanges > 0
              ? `Commit or stash your ${totalChanges} local change${totalChanges !== 1 ? 's' : ''} before pulling`
              : behindCount > 0
              ? `${behindCount} commit${behindCount !== 1 ? 's' : ''} behind origin — git pull --ff-only`
              : 'Already up to date'
          }
        >
          {pulling ? 'Pulling…' : behindCount > 0 ? `Pull (${behindCount})` : 'Pull'}
        </button>
      )}
      {pullResult && (
        <span className={`text-xs ${pullResult.includes('failed') || pullResult.includes('error') ? 'text-status-error' : 'text-status-success'}`}>
          {pullResult}
        </span>
      )}
      {projectName && (
        <Link
          href={`/pipeline?project=${encodeURIComponent(projectName)}`}
          className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer inline-flex items-center no-underline font-medium"
        >
          Pipeline
        </Link>
      )}
      {githubUrl && (
        <a
          className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer inline-flex items-center font-medium"
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub &#8599;
        </a>
      )}
    </>
  )
}
