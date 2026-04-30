'use client'

import Link from 'next/link'
import type { CustomAction, ProjectConfig } from '@/lib/client-api'

const BTN_BASE = 'px-3 py-1.5 text-sm rounded-md font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'
const BTN_SECONDARY = `${BTN_BASE} border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary`
const BTN_GHOST = `${BTN_BASE} border border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/60`
const BTN_PRIMARY = `${BTN_BASE} border border-accent bg-accent/10 text-accent hover:bg-accent/20`
const BTN_WARNING = `${BTN_BASE} border border-status-warning/60 bg-status-warning/10 text-status-warning hover:bg-status-warning/20`
const BTN_ERROR = `${BTN_BASE} border border-status-error text-status-error hover:bg-status-error/10`
const BTN_INFO = `${BTN_BASE} border border-status-info/50 bg-status-info/10 text-status-info hover:bg-status-info/20`

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

  const pullPrimaryDisabled = pulling || totalChanges > 0 || behindCount === 0
  const pullClass = totalChanges > 0
    ? `${BTN_BASE} border border-border bg-bg-secondary text-text-primary cursor-not-allowed`
    : behindCount > 0
      ? BTN_WARNING
      : BTN_SECONDARY

  return (
    <>
      {aggregateCi === 'failure' && ciFailedUrl && (
        <button
          className={BTN_ERROR}
          onClick={onFixCi}
          disabled={fixingCi || isCiFixRunning}
          title={isCiFixRunning ? 'CI fix already in progress' : 'Start CI fix'}
        >
          {fixingCi || isCiFixRunning ? 'CI Fix in Progress…' : 'Fix CI'}
        </button>
      )}
      {fixCiResult && (
        <span className={`text-xs ${fixCiResult.startsWith('CI fix started') ? 'text-status-success' : 'text-status-error'}`}>
          {fixCiResult}
        </span>
      )}
      <button
        className={BTN_PRIMARY}
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
          className={BTN_SECONDARY}
          onClick={onCreatePr}
          disabled={createPrDisabled}
          title={createPrTitle}
        >
          {creatingPr ? 'Creating PR…' : 'Create PR'}
        </button>
      )}
      {hasOpenPr && totalChanges > 0 && (
        <button
          className={BTN_SECONDARY}
          onClick={onPushToPr}
          disabled={pushingToPr}
          title={`Stage ${totalChanges} change${totalChanges === 1 ? '' : 's'}, commit (Claude-generated message), push — attaches to existing PR. Skips test + review (use Release for the full pipeline).`}
        >
          {pushingToPr ? 'Pushing…' : `Push to PR${openPrByBranch[currentBranch ?? ''] ? ` #${openPrByBranch[currentBranch ?? '']}` : ''}`}
        </button>
      )}
      {hasTestCommand && (
        <button
          className={BTN_SECONDARY}
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
          {runningActions.has(action.name) ? `${action.name}…` : action.name}
        </button>
      ))}
      {(unpushed ?? 0) > 0 && totalChanges === 0 && (
        <button
          className={BTN_WARNING}
          onClick={onPush}
          disabled={pushing}
          title={`Push ${unpushed} commit${unpushed !== 1 ? 's' : ''} to origin`}
        >
          {pushing ? 'Pushing…' : `Push (${unpushed})`}
        </button>
      )}
      {pullDiverged ? (
        <span className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-md bg-status-error/10 border border-status-error/40">
          <span className="text-xs text-status-error font-medium">Diverged:</span>
          <button
            className={BTN_INFO}
            onClick={() => onPull('rebase')}
            disabled={pulling}
            title="git pull --rebase"
          >
            {pulling ? 'Working…' : 'Rebase'}
          </button>
          <button
            className={BTN_SECONDARY}
            onClick={() => onPull('merge')}
            disabled={pulling}
            title="git pull --no-ff"
          >
            {pulling ? 'Working…' : 'Merge'}
          </button>
          <button
            className="px-1.5 py-1 text-xs text-text-tertiary hover:text-text-secondary cursor-pointer"
            onClick={onDismissDiverged}
            aria-label="Dismiss diverged warning"
            title="Dismiss"
          >✕</button>
        </span>
      ) : (
        <button
          className={pullClass}
          onClick={() => onPull('ff-only')}
          disabled={pullPrimaryDisabled}
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
      {(projectName || githubUrl) && (
        <span className="mx-1 self-center h-5 w-px bg-border/60" aria-hidden="true" />
      )}
      {projectName && (
        <Link
          href={`/pipeline?project=${encodeURIComponent(projectName)}`}
          className={`${BTN_GHOST} inline-flex items-center no-underline`}
          title="View pipeline metrics for this project"
        >
          Pipeline
        </Link>
      )}
      {githubUrl && (
        <a
          className={`${BTN_GHOST} inline-flex items-center gap-1 no-underline`}
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
