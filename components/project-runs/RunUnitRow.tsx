'use client'

import { formatAgo } from '@/lib/shared/format'
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes'
import { formatDuration, formatTokens, formatCost } from '@/components/project-runs/formatting'
import { entryIsRunning, entryNeedsAttention, shouldShowStableKindTitle } from '@/components/project-runs/entries'
import { KIND_LABEL, KIND_COLOR, runKindDisplayName } from '@/components/project-runs/kinds'
import { formatRunSummaryText, splitSummary, lastFailedSummaryPart, latestFailureSummary } from '@/components/project-runs/run-summary'
import {
  rowStateInfo,
  verdictBadgeInfo,
  gemmaOutcomeInfo,
  releaseOutcomeInfo,
  progressToneClass,
  promptBloat,
  modifiedFileCount,
} from '@/components/project-runs/presentation'
import type { Entry } from '@/components/project-runs/types'
import { Pill } from '@/components/ui/Pill'
import { StatusIcon as UiStatusIcon } from '@/components/ui/StatusIcon'
import { PulseDot } from '@/components/ui/PulseDot'

function RowStatusIcon({ running, needsAttention }: { running: boolean; needsAttention: boolean }) {
  if (running) {
    return (
      <span className="relative flex h-5 w-5 items-center justify-center rounded-full border border-status-info/30 bg-status-info/10 text-status-info" aria-label="running">
        <span className="absolute h-2 w-2 animate-ping rounded-full bg-status-info opacity-50" />
        <span className="relative h-2 w-2 rounded-full bg-status-info" />
      </span>
    )
  }
  return <UiStatusIcon ok={!needsAttention} className="h-5 w-5" ariaLabel={needsAttention ? 'needs attention' : 'done'} />
}

export interface RunUnitRowProps {
  entry: Entry
  onClick: () => void
  /** Release recap ("test ✓ · review LGTM · commit ✓ · push ✓") for release/owning rows. */
  summary?: string | null
  progressLabel?: string | null
  actions?: React.ReactNode
  showProject?: boolean
}

// One work unit as a single clickable row. Opening the detail drawer carries
// the full pipeline timeline + report, so this row stays flat: no chevron,
// depth connectors, or nested rows (that machinery lives in the legacy RunRow
// used by the global /runs page).
export function RunUnitRow({ entry: e, onClick, summary, progressLabel, actions, showProject = false }: RunUnitRowProps) {
  const isRunning = e.status === 'running'
  const effectiveRunning = entryIsRunning(e)
  const effectiveNeedsAttention = entryNeedsAttention(e)

  const statusFailureLabel = e.failureLabel
    ?? (e.status === 'aborted' || isCancelledExitCode(e.exitCode) ? 'cancelled' : null)
    ?? (e.releaseOutcome?.status === 'blocked' || e.releaseOutcome?.status === 'failed' ? e.releaseOutcome.label : null)
    ?? (e.kind === 'review' && e.verdict === 'DO NOT SHIP'
      ? 'do not ship'
      : e.kind === 'review' && e.verdict == null && e.status === 'done'
      ? 'review verdict missing'
      : e.kind === 'review' && effectiveNeedsAttention
      ? 'review needs attention'
      : null)

  const summaryParts = splitSummary(summary)
  const failedStepLabel = effectiveNeedsAttention
    ? e.bucket === 'release' && statusFailureLabel === 'release failed'
      ? null
      : progressLabel ?? lastFailedSummaryPart(summaryParts)
    : null

  const state = rowStateInfo({
    isRunning: effectiveRunning,
    isFailed: effectiveNeedsAttention,
    exitCode: e.exitCode,
    failureLabel: failedStepLabel ?? statusFailureLabel,
  })

  const isHardFailed = !isRunning && e.exitCode !== null && e.exitCode !== 0
  const verdict = !isRunning && !isHardFailed ? verdictBadgeInfo(e.verdict) : null
  const isConversationalRow = e.bucket === 'run' || e.bucket === 'agent'
  const gemma = isConversationalRow && !isRunning ? gemmaOutcomeInfo(e.outcomeVerdict) : null
  const releaseBadge = e.bucket === 'release' ? null : releaseOutcomeInfo(e.releaseOutcome)
  const showProgress = !!progressLabel && effectiveRunning
  const bloat = promptBloat(e.promptBytes)

  const fileCount = modifiedFileCount(e.modifiedFiles)
  const totalTokens = e.inputTokens + e.outputTokens
  const durationLabel = formatDuration(e.startedAt, e.finishedAt)

  const ownFailureDetail = !effectiveRunning && effectiveNeedsAttention && isConversationalRow ? formatRunSummaryText(e.detail) : null
  const ownSummary = isConversationalRow ? formatRunSummaryText(e.workSummary) : null
  const childFailureSummary = effectiveNeedsAttention ? formatRunSummaryText(latestFailureSummary(e)) : null
  const releaseStopSummary = effectiveNeedsAttention && e.bucket === 'release' && e.releaseStopReason ? formatRunSummaryText(e.releaseStopReason) : null
  // An agent/run row that owns a failed release-after-run went red because of
  // that release — surface its reason (highest priority) so the failure is
  // explained instead of falling back to this row's own work summary.
  const releaseOutcomeReason = effectiveNeedsAttention && e.bucket !== 'release' && e.releaseOutcome?.reason ? formatRunSummaryText(e.releaseOutcome.reason) : null
  const runSummary = effectiveRunning ? null : (releaseOutcomeReason ?? ownFailureDetail ?? ownSummary ?? childFailureSummary ?? releaseStopSummary)
  const liveDetail = effectiveRunning
    ? (isConversationalRow && e.workSummary ? formatRunSummaryText(e.workSummary) : e.subtitle?.trim() || null)
    : null
  const detailLine = runSummary ?? liveDetail
  const detailEyebrow = effectiveNeedsAttention ? 'reason' : runSummary ? 'done' : 'current'

  const rowTone = effectiveRunning ? 'bg-status-info/5' : effectiveNeedsAttention ? 'bg-status-error/5' : 'bg-bg-primary'
  const showStableKindTitle = shouldShowStableKindTitle(e)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick() } }}
      className={`group flex cursor-pointer flex-wrap items-start gap-x-4 gap-y-2 border-b border-border px-4 py-2.5 transition-colors last:border-b-0 hover:bg-bg-tertiary lg:flex-nowrap ${rowTone}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 shrink-0"><RowStatusIcon running={effectiveRunning} needsAttention={effectiveNeedsAttention} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`inline-flex h-5 min-w-[52px] shrink-0 items-center justify-center rounded px-1.5 font-mono text-[10px] font-semibold ${KIND_COLOR[e.bucket]}`}>
              {KIND_LABEL[e.bucket]}
            </span>
            {showStableKindTitle && (
              <span className="shrink-0 text-sm font-medium text-text-primary">{runKindDisplayName(e.kind)}</span>
            )}
            <span className="min-w-0 truncate text-sm font-medium text-text-primary group-hover:text-accent" title={e.title}>{e.title}</span>
          </div>

          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-tertiary">
            <span className="shrink-0 font-mono"><span className="mr-1">started</span>{formatAgo(e.startedAt)}</span>
            {e.parentLabel && (<span className="min-w-0 truncate">← <span className="font-mono text-accent">{e.parentLabel}</span></span>)}
            {showProject && <span className="shrink-0 font-mono text-text-secondary">{e.project}</span>}
            {e.navSessionId && <span className="shrink-0 font-mono">#{e.navSessionId.slice(0, 8)}</span>}
            {e.turns > 1 && <span className="shrink-0 font-mono">{e.turns} turns</span>}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Pill tone={state.tone} size="xs" className="h-5 gap-1.5 rounded px-1.5 text-[10px]">
              {state.running && <PulseDot size="xs" />}
              {state.label}
            </Pill>
            {verdict && (
              <Pill tone={verdict.tone} size="xs" className="h-5 rounded px-1.5 font-mono text-[10px]" title={`Review verdict: ${e.verdict}`}>{verdict.label}</Pill>
            )}
            {gemma && (
              <Pill tone={gemma.tone} size="xs" className="h-5 rounded px-1.5 font-mono text-[10px]" title="Local-LLM outcome verdict">{gemma.label}</Pill>
            )}
            {e.followupIssueUrl && (
              <a
                href={e.followupIssueUrl}
                target="_blank"
                rel="noreferrer"
                title="Follow-up issue filed for this review's findings"
                onClick={(ev) => ev.stopPropagation()}
                className="inline-flex h-5 items-center rounded border border-status-warning/40 bg-status-warning/15 px-1.5 font-mono text-[10px] font-medium text-status-warning transition-colors hover:bg-status-warning/25"
              >
                ↗ filed{e.followupIssueNumber != null ? ` #${e.followupIssueNumber}` : ''}
              </a>
            )}
            {releaseBadge && (
              <Pill tone={releaseBadge.tone} size="xs" className="h-5 gap-1 rounded px-1.5 text-[10px]">{releaseBadge.label}</Pill>
            )}
            {showProgress && (
              <Pill size="xs" className={`h-5 rounded px-1.5 font-mono text-[10px] ${progressToneClass(progressLabel)}`}>{progressLabel}</Pill>
            )}
            {bloat.show && (
              <Pill
                size="xs"
                className={`h-5 rounded px-1.5 font-mono text-[10px] ${bloat.alert ? 'border-status-error/30 bg-status-error/15 text-status-error' : 'border-status-warning/30 bg-status-warning/15 text-status-warning'}`}
                title={`Prompt piped to provider: ${bloat.bytes.toLocaleString()} bytes (~${Math.round(bloat.bytes / 4).toLocaleString()} tokens). Every cache-read of this prefix is billed.`}
              >
                prompt {bloat.label}
              </Pill>
            )}
            {e.logPruned && (
              <Pill size="xs" className="h-5 rounded border-transparent bg-text-tertiary/15 px-1.5 text-[10px] text-text-tertiary" title="Log file deleted by retention policy">pruned</Pill>
            )}
          </div>

          {summary && (
            <div className="mt-1.5 truncate font-mono text-[11px] text-text-tertiary" title={summary}>{summary}</div>
          )}
          {detailLine && (
            <div className="mt-1 flex min-w-0 items-baseline gap-1.5 text-xs leading-5 text-text-secondary" title={detailLine}>
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-text-tertiary">{detailEyebrow}</span>
              <span className="min-w-0 truncate">{detailLine}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-4 pl-8 lg:pl-0">
        <span className="font-mono text-sm font-semibold tabular-nums text-text-primary" title="Duration">{durationLabel}</span>
        <div className="min-w-0 text-right text-xs text-text-tertiary">
          {(totalTokens > 0 || e.costUsd > 0 || fileCount > 0 || e.model) ? (
            <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
              {e.model && <span className="max-w-[140px] truncate font-mono text-accent" title={e.model}>{e.model}</span>}
              {fileCount > 0 && <span className="font-mono">{fileCount} file{fileCount === 1 ? '' : 's'}</span>}
              {totalTokens > 0 && (
                <span className="font-mono tabular-nums" title="Input / output tokens">
                  <span className="text-status-success">↑{formatTokens(e.inputTokens)}</span>{' '}
                  <span className="text-accent">↓{formatTokens(e.outputTokens)}</span>
                </span>
              )}
              {e.costUsd > 0 && <span className="font-mono tabular-nums text-text-secondary" title="Estimated cost">{formatCost(e.costUsd)}</span>}
            </div>
          ) : (
            <span className="text-text-tertiary">—</span>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
    </div>
  )
}
