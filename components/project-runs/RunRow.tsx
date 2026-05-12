'use client'

import { formatAgo } from '@/lib/shared/format'
import { formatDuration, formatTokens, formatCost, KIND_LABEL, KIND_COLOR, entryIsRunning, entryNeedsAttention } from '@/components/project-runs/utils'
import type { Entry } from '@/components/project-runs/utils'
import { MetaChip } from '@/components/MetaChip'

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
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full font-medium font-mono ${
      verdict === 'LGTM' ? 'bg-status-success/15 text-status-success border border-status-success/30' :
      verdict === 'DO NOT SHIP' ? 'bg-status-error/15 text-status-error border border-status-error/30' :
      'bg-status-warning/15 text-status-warning border border-status-warning/30'
    }`} title={`Review verdict: ${verdict}`}>
      {verdict === 'LGTM' ? '✓ LGTM' : verdict === 'DO NOT SHIP' ? '✗ DNS' : '⚠ ATTN'}
    </span>
  )
}

function ReleaseOutcomeBadge({ entry }: { entry: Entry }) {
  const outcome = entry.releaseOutcome
  if (!outcome) return null
  const cls =
    outcome.status === 'running' ? 'bg-status-info/15 text-status-info border-status-info/30' :
    outcome.status === 'done' ? 'bg-status-success/15 text-status-success border-status-success/30' :
    outcome.status === 'blocked' ? 'bg-status-warning/15 text-status-warning border-status-warning/30' :
    'bg-status-error/15 text-status-error border-status-error/30'
  const label = outcome.status === 'done' ? '✓ release done' : outcome.label
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full font-medium border ${cls}`}>
      {label}
    </span>
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
      <span className="inline-flex items-center gap-1.5 rounded-full border border-status-info/30 bg-status-info/15 px-1.5 py-0.5 text-[10px] font-medium text-status-info">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-info opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-status-info" />
        </span>
        running
      </span>
    )
  }

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
      isFailed
        ? 'border-status-error/30 bg-status-error/15 text-status-error'
        : 'border-status-success/30 bg-status-success/15 text-status-success'
    }`}>
      {isFailed ? (failureLabel ?? `exit ${exitCode}`) : 'done'}
    </span>
  )
}

export function RunRow({ entry: e, onClick, expandable, expanded, onToggleExpand, summary, progressLabel, actions, depth = 0, children }: RunRowProps) {
  const isRunning = e.status === 'running'
  const effectiveRunning = entryIsRunning(e)
  const effectiveNeedsAttention = entryNeedsAttention(e)
  const statusFailureLabel = e.failureLabel
    ?? (e.status === 'aborted' || e.exitCode === -3
      ? 'cancelled'
      : null)
    ?? (e.kind === 'review' && e.verdict === 'DO NOT SHIP'
      ? 'do not ship'
      : e.kind === 'review' && e.verdict == null && e.status === 'done'
      ? 'review verdict missing'
      : e.kind === 'review' && effectiveNeedsAttention
      ? 'review needs attention'
      : null)
  const totalTokens = e.inputTokens + e.outputTokens
  const fileCount = modifiedFileCount(e.modifiedFiles)
  const durationLabel = formatDuration(e.startedAt, e.finishedAt)
  const startedLabel = formatAgo(e.startedAt)
  const runSummary = (effectiveRunning ? null : e.workSummary)?.trim() || null
  const liveDetail = (effectiveRunning ? (e.workSummary ?? e.subtitle) : null)?.trim() || null
  const summaryParts = splitSummary(summary)
  const statusBadge = (
    <RowStateBadge
      isRunning={effectiveRunning}
      isFailed={effectiveNeedsAttention}
      exitCode={e.exitCode}
      failureLabel={statusFailureLabel}
    />
  )
  const verdictBadge = (
    <VerdictBadge
      verdict={e.verdict}
      isRunning={isRunning}
      isFailed={!isRunning && e.exitCode !== null && e.exitCode !== 0}
    />
  )
  // ReleaseOutcomeBadge is only useful when the entry itself isn't a
  // release — i.e. an agent/run that owns a separate release outcome chip.
  // For release/vgroup entries the row's RowStateBadge already conveys the
  // outcome, and showing a second "release done"/"release failed" pill
  // duplicates that. Hide it on those rows.
  const releaseBadge = e.bucket === 'release' ? null : <ReleaseOutcomeBadge entry={e} />
  // Top-level rows (depth=0) get a wider, always-colored status border so
  // the outcome of every item is scannable at a glance. Child rows keep a
  // thinner border and only color it for running/failed (success stays quiet).
  const borderWidth = depth === 0 ? 'border-l-[3px]' : 'border-l-2'
  const accentBorder = effectiveRunning
    ? `${borderWidth} border-l-status-info`
    : effectiveNeedsAttention
    ? `${borderWidth} ${e.releaseOutcome?.status === 'blocked' ? 'border-l-status-warning' : 'border-l-status-error'}`
    : depth === 0
    ? `${borderWidth} border-l-status-success`
    : 'border-l-2 border-l-transparent'
  const paddingLeft = DEPTH_PADDING[Math.min(depth, 6)] ?? 'pl-52'

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
    <div className="border-b border-border last:border-b-0 relative">
      {connectors}
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick() } }}
        className={`w-full text-left hover:bg-bg-tertiary cursor-pointer ${paddingLeft} pr-4 py-2 flex items-start gap-3 group ${accentBorder}`}
      >
        {expandable ? (
          <button
            type="button"
            className="shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center text-text-tertiary hover:text-text-primary cursor-pointer border-none bg-transparent"
            onClick={(ev) => { ev.stopPropagation(); onToggleExpand?.() }}
            title={expanded ? 'Collapse steps' : 'Expand steps'}
          >
            <span className={`transition-transform inline-block ${expanded ? 'rotate-90' : ''}`}>▸</span>
          </button>
        ) : (
          // Reserve the chevron column on non-expandable rows so kind badges
          // line up vertically across the table whether or not a row is a
          // release parent.
          <span className="shrink-0 mt-0.5 w-5 h-5" aria-hidden="true" />
        )}

        <span className={`shrink-0 mt-0.5 inline-flex items-center justify-center min-w-[58px] px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded ${KIND_COLOR[e.bucket]}`}>
          {KIND_LABEL[e.bucket]}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-text-primary font-medium truncate group-hover:text-accent">
                {e.title}
              </div>
              <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                {statusBadge}
                {verdictBadge}
                {releaseBadge}
                {progressLabel && (
                  <span className="inline-flex items-center rounded-full border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium font-mono text-accent">
                    step: {progressLabel}
                  </span>
                )}
                {e.logPruned && (
                  <span className="inline-flex items-center rounded-full bg-text-tertiary/15 px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary" title="Log file deleted by retention policy">
                    pruned
                  </span>
                )}
              </div>
              {(runSummary || liveDetail || summaryParts.length > 0) && (
                <div className="mt-2 space-y-2">
                  {runSummary && (
                    <div className="rounded-md border border-border bg-bg-primary/40 px-2.5 py-2 text-sm leading-5 text-text-secondary">
                      {runSummary}
                    </div>
                  )}
                  {!runSummary && liveDetail && (
                    <div className="rounded-md border border-border bg-bg-primary/30 px-2 py-1.5 text-xs leading-5 text-text-secondary">
                      {liveDetail}
                    </div>
                  )}
                  {summaryParts.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {summaryParts.map((part, index) => (
                        <span
                          key={`${index}:${part}`}
                          className="rounded-md border border-border bg-bg-primary/40 px-2 py-1 text-[11px] font-mono leading-5 text-text-secondary"
                        >
                          {part}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <div className="font-mono text-sm font-semibold tabular-nums text-text-primary">
                {durationLabel}
              </div>
              <div className="mt-1 flex justify-end">
                <MetaChip label="started" value={startedLabel} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-x-2 gap-y-1 text-xs text-text-tertiary mt-1.5 flex-wrap">
            {/* When depth > 0 the chain visualization on the left edge already
                shows what spawned this row — the badge becomes noisy. Keep
                the parent label as a hover title on the chain connector for
                screen readers and tooltip lookup, but don't render the
                redundant inline `← test` badge. */}
            {e.parentLabel && depth === 0 && (
              <span
                className="inline-flex items-center gap-1 shrink-0"
                title={`Started by ${e.parentLabel} (${e.parentJobId?.slice(-12) ?? ''})`}
              >
                <span className="text-text-tertiary text-[10px]">←</span>
                <span className="px-1.5 py-0.5 text-[10px] font-mono font-medium rounded bg-accent/10 text-accent border border-accent/25">
                  {e.parentLabel}
                </span>
              </span>
            )}
            {e.turns > 1 && <span className="font-mono">{e.turns} turns</span>}
            {e.model && <MetaChip label="model" value={e.model} tone="accent" />}
            {e.navSessionId && <MetaChip label="session" value={`#${e.navSessionId.slice(0, 8)}`} />}
            {e.releaseOutcome && !summary && <span className="font-mono text-text-secondary">{e.releaseOutcome.label}</span>}
            {e.subtitle && !summary && <span className="italic truncate">{e.subtitle}</span>}
            {fileCount > 0 && e.bucket === 'agent' && (
              <span className="font-mono rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary border border-border">
                {fileCount} file{fileCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>

        <div className="shrink-0 flex flex-col items-end gap-1 text-xs">
          {(totalTokens > 0 || e.costUsd > 0) && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-bg-primary/50 px-2 py-1">
              {totalTokens > 0 && (
                <span className="font-mono text-text-tertiary" title="Input / output tokens">
                  <span className="text-status-success">↑{formatTokens(e.inputTokens)}</span>{' '}
                  <span className="text-accent">↓{formatTokens(e.outputTokens)}</span>
                </span>
              )}
              {e.costUsd > 0 && (
                <span className="font-mono text-accent/70" title="Estimated cost">
                  {formatCost(e.costUsd)}
                </span>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            {actions && (
              <span onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
                {actions}
              </span>
            )}
          </div>
        </div>
      </div>
      {children}
    </div>
  )
}
