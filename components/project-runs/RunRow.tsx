'use client'

import { formatAgo } from '@/lib/shared/format'
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes'
import { formatDuration, formatTokens, formatCost } from '@/components/project-runs/formatting'
import { entryIsRunning, entryNeedsAttention, shouldShowStableKindTitle } from '@/components/project-runs/entries'
import { KIND_LABEL, KIND_COLOR, runKindDisplayName } from '@/components/project-runs/kinds'
import {
  gemmaOutcomeInfo,
  modifiedFileCount,
  progressToneClass,
  promptBloat,
  releaseOutcomeInfo,
  rowStateInfo,
  stepChipTone,
  verdictBadgeInfo,
} from '@/components/project-runs/presentation'
import {
  formatRunSummaryText,
  lastFailedSummaryPart,
  latestFailureSummary,
  splitSummary,
} from '@/components/project-runs/run-summary'
import type { Entry } from '@/components/project-runs/types'
import { Button } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { StatusIcon as UiStatusIcon } from '@/components/ui/StatusIcon'
import { PulseDot } from '@/components/ui/PulseDot'

export const RUN_ROW_GRID_CLASS = 'lg:grid-cols-[minmax(360px,1.2fr)_minmax(360px,1fr)_96px_120px_minmax(84px,auto)]'

function StatusIcon({
  running,
  needsAttention,
}: {
  running: boolean
  needsAttention: boolean
}) {
  if (running) {
    return (
      <span className="relative flex h-5 w-5 items-center justify-center rounded-full border border-status-info/30 bg-status-info/10 text-status-info" aria-label="running">
        <span className="absolute h-2 w-2 animate-ping rounded-full bg-status-info opacity-50" />
        <span className="relative h-2 w-2 rounded-full bg-status-info" />
      </span>
    )
  }
  if (needsAttention) {
    return (
      <UiStatusIcon ok={false} className="h-5 w-5" ariaLabel="needs attention" />
    )
  }
  return <UiStatusIcon ok={true} className="h-5 w-5" ariaLabel="done" />
}

function StepChip({ value }: { value: string }) {
  return (
    <Pill tone={stepChipTone(value)} size="xs" className="h-5 rounded px-1.5 text-[10px] font-mono">
      {value}
    </Pill>
  )
}

export interface RunRowProps {
  entry: Entry
  onClick: () => void
  expandable?: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  summary?: string | null
  progressLabel?: string | null
  actions?: React.ReactNode
  showProject?: boolean
  // Depth in the chain tree. 0 = top-level row, 1 = direct child of release,
  // 2 = grandchild (e.g. review under test), etc. Drives left padding and
  // the connector tree on the row's left edge.
  depth?: number
  children?: React.ReactNode
}


// Tailwind doesn't see dynamic class names, so map fixed depths → static
// padding-left classes. Anything past depth 6 saturates at the same padding
// — we don't expect chains longer than test → review → fix → review → commit
// → push → mark-dod (depth 6) in practice.
// Steps of 7 (28px) match the connector rail spacing (16 + depth*28 px).
const DEPTH_PADDING: Record<number, string> = {
  0: 'pl-4',
  1: 'pl-11',
  2: 'pl-[74px]',
  3: 'pl-[102px]',
  4: 'pl-[130px]',
  5: 'pl-[158px]',
  6: 'pl-[186px]',
}

function VerdictBadge({
  verdict,
  isRunning,
  isFailed,
}: {
  verdict: string | null | undefined
  isRunning: boolean
  isFailed: boolean
}) {
  // Only render when there's a verdict to convey. The running/done/failed
  // states are already shown by RowStateBadge — emitting a second "done" or
  // "exit X" badge here just duplicates that without adding information.
  if (!verdict || isRunning || isFailed) return null
  const badge = verdictBadgeInfo(verdict)
  if (!badge) return null
  return (
    <Pill tone={badge.tone} size="xs" className="h-5 rounded px-1.5 text-[10px] font-mono" title={`Review verdict: ${verdict}`}>
      {badge.label}
    </Pill>
  )
}

function ReleaseOutcomeBadge({ entry }: { entry: Entry }) {
  const badge = releaseOutcomeInfo(entry.releaseOutcome)
  if (!badge) return null
  return (
    <Pill tone={badge.tone} size="xs" className="h-5 gap-1 rounded px-1.5 text-[10px]">
      {badge.label}
    </Pill>
  )
}

function RowStateBadge({
  isRunning,
  isFailed,
  exitCode,
  failureLabel,
}: {
  isRunning: boolean
  isFailed: boolean
  exitCode: number | null | undefined
  failureLabel?: string | null
}) {
  if (isRunning) {
    return (
      <Pill tone="info" size="xs" className="h-5 gap-1.5 rounded px-1.5 text-[10px]">
        <PulseDot size="xs" />
        running
      </Pill>
    )
  }

  // A -1 exit code is TamTam's sentinel for "the process never exited normally"
  // — a spawn error (proc.on('error')) or a signal kill that left no real exit
  // status (the `code ?? -1` fallback in job close handlers). Rendering it as a
  // literal "exit -1" reads like a real exit status and confuses operators, so
  // surface the actual condition. Cancellations (-2/-3) arrive as a 'cancelled'
  // failureLabel from upstream and never reach this fallback.
  const state = rowStateInfo({ isRunning, isFailed, exitCode, failureLabel })
  return (
    <Pill tone={state.tone} size="xs" className="h-5 gap-1 rounded px-1.5 text-[10px]">
      {state.label}
    </Pill>
  )
}

export function RunRow({ entry: e, onClick, expandable, expanded, onToggleExpand, summary, progressLabel, actions, showProject = false, depth = 0, children }: RunRowProps) {
  const isRunning = e.status === 'running'
  const effectiveRunning = entryIsRunning(e)
  const effectiveNeedsAttention = entryNeedsAttention(e)
  const statusFailureLabel = e.failureLabel
    ?? (e.status === 'aborted' || isCancelledExitCode(e.exitCode)
      ? 'cancelled'
      : null)
    ?? (e.releaseOutcome?.status === 'blocked'
      ? e.releaseOutcome.label
      : e.releaseOutcome?.status === 'failed'
      ? e.releaseOutcome.label
      : null)
    ?? (e.kind === 'review' && e.verdict === 'DO NOT SHIP'
      ? 'do not ship'
      : e.kind === 'review' && e.verdict == null && e.status === 'done'
      ? 'review verdict missing'
      : e.kind === 'review' && effectiveNeedsAttention
      ? 'review needs attention'
      : null)
  const totalTokens = e.inputTokens + e.outputTokens
  const prompt = promptBloat(e.promptBytes)
  const fileCount = modifiedFileCount(e.modifiedFiles)
  const durationLabel = formatDuration(e.startedAt, e.finishedAt)
  const startedLabel = formatAgo(e.startedAt)
  // Pipeline-step rows now carry their work_summary in the title (see
  // titleForJob), so only chat/agent rows surface their own summary on this
  // secondary line — otherwise it would duplicate the title. childFailureSummary
  // is about a parent's failed *children* (releases/agent-owned releases) and
  // still applies regardless of kind.
  const isConversationalRow = e.bucket === 'run' || e.bucket === 'agent'
  const ownFailureDetail =
    !effectiveRunning && effectiveNeedsAttention && isConversationalRow
      ? formatRunSummaryText(e.detail)
      : null
  const ownSummary = isConversationalRow ? formatRunSummaryText(e.workSummary) : null
  const childFailureSummary = effectiveNeedsAttention ? formatRunSummaryText(latestFailureSummary(e)) : null
  const releaseStopSummary =
    effectiveNeedsAttention && e.bucket === 'release' && e.releaseStopReason
      ? formatRunSummaryText(e.releaseStopReason)
      : null
  const runSummary = effectiveRunning ? null : (ownFailureDetail ?? ownSummary ?? childFailureSummary ?? releaseStopSummary)
  const liveDetail = effectiveRunning
    ? (isConversationalRow && e.workSummary ? formatRunSummaryText(e.workSummary) : e.subtitle?.trim() || null)
    : null
  const summaryParts = splitSummary(summary)
  const failedStepLabel = effectiveNeedsAttention
    ? e.bucket === 'release' && statusFailureLabel === 'release failed'
      ? null
      : progressLabel ?? lastFailedSummaryPart(summaryParts)
    : null
  const verdictBadge = (
    <VerdictBadge
      verdict={e.verdict}
      isRunning={isRunning}
      isFailed={!isRunning && e.exitCode !== null && e.exitCode !== 0}
    />
  )
  // Gemma outcome chip — local-LLM classification of how an agent/run
  // turn ended. Only useful on completed run/agent rows; review/test/
  // commit/etc. have their own verdict signals (VerdictBadge above).
  const gemmaVerdictBadge = (() => {
    const badge = gemmaOutcomeInfo(e.outcomeVerdict)
    if (!badge) return null
    if (e.bucket !== 'run' && e.bucket !== 'agent') return null
    if (isRunning) return null
    return (
      <Pill
        tone={badge.tone}
        size="xs"
        className="h-5 rounded px-1.5 text-[10px] font-mono"
        title={`Local-LLM outcome verdict: ${e.outcomeVerdict?.replace('_', ' ')}`}
      >
        {badge.label}
      </Pill>
    )
  })()
  // Audit chip — when a review's DO NOT SHIP / NEEDS-ATTENTION-exhausted
  // verdict caused the orchestrator to file a follow-up GitHub issue, link
  // directly to it from the review row so the audit trail is visible.
  const followupIssueBadge = e.followupIssueUrl ? (
    <a
      href={e.followupIssueUrl}
      target="_blank"
      rel="noreferrer"
      title="Follow-up issue filed for this review's findings"
      onClick={(ev) => ev.stopPropagation()}
      className="inline-flex h-5 items-center rounded border border-status-warning/40 bg-status-warning/15 px-1.5 text-[10px] font-mono font-medium text-status-warning hover:bg-status-warning/25 transition-colors"
    >
      ↗ filed{e.followupIssueNumber != null ? ` #${e.followupIssueNumber}` : ''}
    </a>
  ) : null
  // ReleaseOutcomeBadge is only useful when the entry itself isn't a
  // release — i.e. an agent/run that owns a separate release outcome chip.
  // For release/vgroup entries the row's RowStateBadge already conveys the
  // outcome, and showing a second "release done"/"release failed" pill
  // duplicates that. Hide it on those rows.
  const releaseBadge = e.bucket === 'release' ? null : <ReleaseOutcomeBadge entry={e} />
  const statusBadge = (
    <RowStateBadge
      isRunning={effectiveRunning}
      isFailed={effectiveNeedsAttention}
      exitCode={e.exitCode}
      failureLabel={failedStepLabel ?? statusFailureLabel}
    />
  )
  const paddingLeft = DEPTH_PADDING[Math.min(depth, 6)] ?? 'pl-52'
  const rowTone = effectiveRunning
    ? 'bg-status-info/5'
    : effectiveNeedsAttention
    ? 'bg-status-error/5'
    : 'bg-bg-primary'
  const progressTone = progressToneClass(progressLabel)
  const showProgressBadge = !!progressLabel && effectiveRunning
  const visibleSummaryParts = effectiveNeedsAttention && !failedStepLabel
    ? summaryParts.slice(-1)
    : []
  const stableKindTitle = runKindDisplayName(e.kind)
  const showStableKindTitle = shouldShowStableKindTitle(e)

  // Tree connector lines. Ancestor levels get a full-height vertical rail;
  // the current depth gets a half-height vertical + horizontal stub (└─ shape).
  // Using a stronger color so the hierarchy is clearly readable.
  const connectors: React.ReactNode = depth > 0 ? (
    <span aria-hidden className="absolute left-0 top-0 bottom-0 pointer-events-none select-none">
      {Array.from({ length: depth - 1 }).map((_, i) => (
        <span key={i} className="absolute top-0 bottom-0 border-l border-border" style={{ left: `${16 + i * 28}px` }} />
      ))}
      <span className="absolute border-l border-border" style={{ left: `${16 + (depth - 1) * 28}px`, top: 0, height: '50%' }} />
      <span className="absolute border-t border-border" style={{ left: `${16 + (depth - 1) * 28}px`, top: '50%', width: '10px' }} />
    </span>
  ) : null

  return (
    <div className="border-b border-border last:border-b-0 relative lg:col-span-full lg:grid lg:grid-cols-subgrid">
      {connectors}
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick() } }}
        className={`w-full text-left hover:bg-bg-tertiary cursor-pointer ${paddingLeft} pr-3 py-2 group ${rowTone} transition-colors lg:col-span-full lg:grid lg:grid-cols-subgrid lg:gap-x-3 lg:items-center`}
      >
        <div className={`grid gap-3 lg:contents ${RUN_ROW_GRID_CLASS} lg:items-center`}>
          <div className="flex min-w-0 items-start gap-2">
            {expandable ? (
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                className="mt-0.5 shrink-0 text-text-tertiary hover:text-text-primary"
                onClick={(ev) => { ev.stopPropagation(); onToggleExpand?.() }}
                title={expanded ? 'Collapse steps' : 'Expand steps'}
                aria-expanded={expanded}
              >
                <span className={`transition-transform inline-block ${expanded ? 'rotate-90' : ''}`}>▸</span>
              </Button>
            ) : (
              <span className="h-6 w-6 shrink-0" aria-hidden="true" />
            )}
            <StatusIcon running={effectiveRunning} needsAttention={effectiveNeedsAttention} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className={`shrink-0 inline-flex h-5 min-w-[58px] items-center justify-center rounded px-1.5 text-[10px] font-mono font-semibold ${KIND_COLOR[e.bucket]}`}>
                  {KIND_LABEL[e.bucket]}
                </span>
                {showStableKindTitle && (
                  <span className="shrink-0 text-sm font-medium text-text-primary">
                    {stableKindTitle}
                  </span>
                )}
                <div className="min-w-0 truncate text-sm font-medium text-text-primary group-hover:text-accent" title={e.title}>
                  {e.title}
                </div>
              </div>

              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary">
                <span className="font-mono shrink-0"><span className="mr-1">started</span>{startedLabel}</span>
                {e.parentLabel && depth === 0 && (
                  <span className="min-w-0 truncate">
                    ← <span className="font-mono text-accent">{e.parentLabel}</span>
                  </span>
                )}
                {showProject && (
                  <span className="font-mono shrink-0 text-text-secondary">{e.project}</span>
                )}
                {e.subtitle && !summary && <span className="min-w-0 truncate italic">{e.subtitle}</span>}
                {e.navSessionId && <span className="font-mono shrink-0">#{e.navSessionId.slice(0, 8)}</span>}
                {e.turns > 1 && <span className="font-mono shrink-0">{e.turns} turns</span>}
              </div>
            </div>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              {statusBadge}
              {verdictBadge}
              {gemmaVerdictBadge}
              {followupIssueBadge}
              {releaseBadge}
              {showProgressBadge && (
                <Pill size="xs" className={`h-5 rounded px-1.5 text-[10px] font-mono ${progressTone}`}>
                  {progressLabel}
                </Pill>
              )}
              {prompt.show && (
                <Pill
                  size="xs"
                  className={`h-5 rounded px-1.5 text-[10px] font-mono ${
                    prompt.alert
                      ? 'bg-status-error/15 text-status-error border-status-error/30'
                      : 'bg-status-warning/15 text-status-warning border-status-warning/30'
                  }`}
                  title={`Prompt piped to provider: ${prompt.bytes.toLocaleString()} bytes (~${Math.round(prompt.bytes / 4).toLocaleString()} tokens). Every cache-read of this prefix is billed.`}
                >
                  prompt {prompt.label}
                </Pill>
              )}
              {e.logPruned && (
                <Pill size="xs" className="h-5 rounded border-transparent bg-text-tertiary/15 px-1.5 text-[10px] text-text-tertiary" title="Log file deleted by retention policy">
                  pruned
                </Pill>
              )}
            </div>

            {visibleSummaryParts.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {visibleSummaryParts.map((part, index) => (
                  <StepChip key={`${index}:${part}`} value={part} />
                ))}
              </div>
            )}

            {(runSummary || liveDetail) && (
              <div className="mt-1.5 flex min-w-0 items-baseline gap-1.5 text-xs leading-5 text-text-secondary" title={(runSummary ?? liveDetail) ?? undefined}>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-text-tertiary">
                  {effectiveNeedsAttention ? 'reason' : runSummary ? 'done' : 'current'}
                </span>
                <span className="min-w-0 truncate">{runSummary ?? liveDetail}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 lg:justify-end">
            <span className="font-mono text-sm font-semibold tabular-nums text-text-primary">{durationLabel}</span>
            <span className="text-[10px] uppercase tracking-wider text-text-tertiary lg:hidden">duration</span>
          </div>

          <div className="min-w-0 text-xs text-text-tertiary lg:text-right">
            {(totalTokens > 0 || e.costUsd > 0 || fileCount > 0 || e.model) ? (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 lg:justify-end">
                {e.model && <span className="max-w-[140px] truncate font-mono text-accent" title={e.model}>{e.model}</span>}
                {fileCount > 0 && (
                  <span className="font-mono">{fileCount} file{fileCount === 1 ? '' : 's'}</span>
                )}
                {totalTokens > 0 && (
                  <span className="font-mono tabular-nums" title="Input / output tokens">
                    <span className="text-status-success">↑{formatTokens(e.inputTokens)}</span>{' '}
                    <span className="text-accent">↓{formatTokens(e.outputTokens)}</span>
                  </span>
                )}
                {e.costUsd > 0 && (
                  <span className="font-mono tabular-nums text-text-secondary" title="Estimated cost">
                    {formatCost(e.costUsd)}
                  </span>
                )}
              </div>
            ) : (
              <span className="text-text-tertiary">—</span>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-start lg:justify-end" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
            {actions}
          </div>
        </div>
      </div>
      {children}
    </div>
  )
}
