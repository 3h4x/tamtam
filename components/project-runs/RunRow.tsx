'use client'

import { formatAgo } from '@/lib/shared/format'
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes'
import { formatDuration, formatTokens, formatCost, KIND_LABEL, KIND_COLOR, entryIsRunning, entryNeedsAttention, runKindDisplayName, shouldShowStableKindTitle } from '@/components/project-runs/utils'
import type { Entry } from '@/components/project-runs/utils'
import { Button } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { StatusIcon as UiStatusIcon } from '@/components/ui/StatusIcon'
import type { PillTone } from '@/components/ui/Pill'
import { PulseDot } from '@/components/ui/PulseDot'

export const RUN_ROW_GRID_CLASS = 'lg:grid-cols-[minmax(360px,1.2fr)_minmax(360px,1fr)_96px_120px_minmax(84px,auto)]'

function modifiedFileCount(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

function splitSummary(summary: string | null | undefined): string[] {
  if (!summary) return []
  return summary
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean)
}

function lastFailedSummaryPart(parts: string[]): string | null {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]
    const lower = part.toLowerCase()
    if (part.includes('✗') || lower.includes('fail') || lower.includes('attention') || lower.includes('blocked') || lower.includes('pending')) {
      return part
    }
  }
  return null
}

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
  const lower = value.toLowerCase()
  const failed = value.includes('✗') || lower.includes('fail') || lower.includes('attention') || lower.includes('ship') || lower.includes('blocked')
  const pending = lower.includes('pending') || lower.includes('queued') || lower.includes('running')
  const done = lower.includes('✓') || lower.includes('lgtm') || lower.includes('done') || lower.includes('completed')
  const tone: PillTone = failed
    ? 'error'
    : pending
    ? 'info'
    : done
    ? 'success'
    : 'neutral'
  return (
    <Pill tone={tone} size="xs" className="h-5 rounded px-1.5 text-[10px] font-mono">
      {value}
    </Pill>
  )
}

const SUMMARY_SECTION_LABELS = [
  'Summary:',
  'Files changed:',
  'Actionable work:',
  'Fixes applied:',
  'Findings NOT fixed:',
  'Verification completed:',
  'UX verdict per flow:',
]

const SUMMARY_SECTION_PATTERN = SUMMARY_SECTION_LABELS
  .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

const STRUCTURED_SUMMARY_RE = new RegExp(
  `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:\\*\\*)?(?:${SUMMARY_SECTION_PATTERN})(?:\\*\\*)?\\s*`,
  'i',
)

const INLINE_SECTION_RE = new RegExp(`\\s+(?=(?:${SUMMARY_SECTION_PATTERN}))`, 'g')

// Compile per-label "label \s*" regexes ONCE at module load. Without this,
// `formatRunSummaryText` allocated len(SUMMARY_SECTION_LABELS) regex
// objects on every call, plus one more for the leading-bullet strip — and
// the function is invoked once per visible run row's summary. For a 50-row
// list × 8 regexes each, that's 400 RegExp allocations per render cycle.
const LEADING_BULLET_BEFORE_SECTION_RE = new RegExp(
  `^\\s*[-*]\\s+(?=(?:${SUMMARY_SECTION_PATTERN}))`,
  'gm',
)
const SECTION_BREAK_RES: ReadonlyArray<{ label: string; re: RegExp }> = SUMMARY_SECTION_LABELS.map((label) => ({
  label,
  re: new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'),
}))

function formatRunSummaryText(value: string | null | undefined): string | null {
  if (!value) return null

  const trimmed = value.trim()
  if (!trimmed) return null
  if (!STRUCTURED_SUMMARY_RE.test(trimmed)) return trimmed

  let text = value
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*---+\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(LEADING_BULLET_BEFORE_SECTION_RE, '')

  text = text.replace(INLINE_SECTION_RE, '\n')

  for (const { label, re } of SECTION_BREAK_RES) {
    text = text.replace(re, `${label}\n`)
  }

  text = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')

  return text || null
}

function latestFailureSummary(entry: Entry): string | null {
  const children: Entry[] = []
  const seen = new Set<string>()
  const collect = (nodes: Entry[]) => {
    for (const node of nodes) {
      if (seen.has(node.key)) continue
      seen.add(node.key)
      children.push(node)
      collect(node.children ?? [])
      collect(node.chainedChildren ?? [])
    }
  }
  collect([...(entry.children ?? []), ...(entry.chainedChildren ?? [])])
  const failedChildren = children
    .filter((child) => entryNeedsAttention(child))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const latestFailure = failedChildren.find((child) => child.workSummary || child.subtitle || child.detail)
    ?? failedChildren[0]
  // Fall back to `detail` (the error extracted from the failed step's log tail,
  // see lib/jobs/storage.ts failureDetailForList) so a step that failed without
  // a work_summary still surfaces its reason instead of a bare "exit 1".
  return latestFailure?.workSummary ?? latestFailure?.subtitle ?? latestFailure?.detail ?? null
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
  const tone: PillTone = verdict === 'LGTM'
    ? 'success'
    : verdict === 'DO NOT SHIP'
    ? 'error'
    : 'warning'
  const label = verdict === 'LGTM' ? '✓ LGTM' : verdict === 'DO NOT SHIP' ? '✗ DNS' : '⚠ ATTN'
  return (
    <Pill tone={tone} size="xs" className="h-5 rounded px-1.5 text-[10px] font-mono" title={`Review verdict: ${verdict}`}>
      {label}
    </Pill>
  )
}

function ReleaseOutcomeBadge({ entry }: { entry: Entry }) {
  const outcome = entry.releaseOutcome
  if (!outcome) return null
  const tone: PillTone =
    outcome.status === 'running' ? 'info' :
    outcome.status === 'done' ? 'success' :
    outcome.status === 'blocked' ? 'warning' :
    'error'
  const label = outcome.status === 'done' ? '✓ release done' : outcome.label
  return (
    <Pill tone={tone} size="xs" className="h-5 gap-1 rounded px-1.5 text-[10px]">
      {label}
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
  const failedText = failureLabel ?? (exitCode === -1 ? 'failed to start' : `exit ${exitCode}`)
  return (
    <Pill tone={isFailed ? 'error' : 'success'} size="xs" className="h-5 gap-1 rounded px-1.5 text-[10px]">
      {isFailed ? failedText : 'done'}
    </Pill>
  )
}

export function RunRow({ entry: e, onClick, expandable, expanded, onToggleExpand, summary, progressLabel, actions, depth = 0, children }: RunRowProps) {
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
  // Prompt-bloat indicator. Every cache-read of an oversized prefix is billed,
  // so a fat prompt is real recurring cost. Show the chip from 20 KB and turn
  // it red at 50 KB — these are heuristic, picked from the typical
  // CLAUDE.md (~30 KB) + skills + diff envelope observed on tamtam runs.
  const PROMPT_BYTES_WARN = 20_000
  const PROMPT_BYTES_ALERT = 50_000
  const promptBytes = e.promptBytes ?? 0
  const showPromptChip = promptBytes >= PROMPT_BYTES_WARN
  const promptIsAlert = promptBytes >= PROMPT_BYTES_ALERT
  const promptKbLabel = promptBytes >= 1024 ? `${Math.round(promptBytes / 1024)}KB` : `${promptBytes}B`
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
    const v = e.outcomeVerdict
    if (!v) return null
    if (e.bucket !== 'run' && e.bucket !== 'agent') return null
    if (isRunning) return null
    const label = v === 'done' ? '✓ done' : v === 'asked_question' ? '? asked' : '↻ unfinished'
    const tone: PillTone = v === 'done'
      ? 'success'
      : v === 'asked_question'
      ? 'info'
      : 'warning'
    return (
      <Pill
        tone={tone}
        size="xs"
        className="h-5 rounded px-1.5 text-[10px] font-mono"
        title={`Local-LLM outcome verdict: ${v.replace('_', ' ')}`}
      >
        {label}
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
  const progressTone = progressLabel?.includes('now:')
    ? 'border-status-info/30 bg-status-info/10 text-status-info'
    : progressLabel?.includes('failed') || progressLabel?.includes('stopped') || progressLabel?.includes('cancelled') || progressLabel?.includes('blocked')
      ? 'border-status-error/30 bg-status-error/10 text-status-error'
      : 'border-accent/25 bg-accent/10 text-accent'
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
              {showPromptChip && (
                <Pill
                  size="xs"
                  className={`h-5 rounded px-1.5 text-[10px] font-mono ${
                    promptIsAlert
                      ? 'bg-status-error/15 text-status-error border-status-error/30'
                      : 'bg-status-warning/15 text-status-warning border-status-warning/30'
                  }`}
                  title={`Prompt piped to provider: ${promptBytes.toLocaleString()} bytes (~${Math.round(promptBytes / 4).toLocaleString()} tokens). Every cache-read of this prefix is billed.`}
                >
                  prompt {promptKbLabel}
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
