'use client'

import { formatAgo } from '@/lib/shared/format'
import { formatDuration, formatTokens, formatCost, KIND_LABEL, KIND_COLOR } from '@/components/project-runs/utils'
import type { Entry } from '@/components/project-runs/utils'

export interface RunRowProps {
  entry: Entry
  onClick: () => void
  expandable?: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  summary?: string | null
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

function VerdictBadge({ verdict, isRunning, isFailed, exitCode }: { verdict: string | null | undefined; isRunning: boolean; isFailed: boolean; exitCode: number | null | undefined }) {
  if (verdict && !isRunning && !isFailed) {
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
  if (isRunning) {
    return (
      <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-status-info/15 text-status-info border border-status-info/30">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-info opacity-60" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-status-info" />
        </span>
        running
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full font-medium border ${
      isFailed ? 'bg-status-error/15 text-status-error border-status-error/30' :
      'bg-status-success/15 text-status-success border-status-success/30'
    }`}>
      {isFailed ? `exit ${exitCode}` : '✓ done'}
    </span>
  )
}

export function RunRow({ entry: e, onClick, expandable, expanded, onToggleExpand, summary, depth = 0, children }: RunRowProps) {
  const isRunning = e.status === 'running'
  const isFailed = !isRunning && e.exitCode !== null && e.exitCode !== 0
  const totalTokens = e.inputTokens + e.outputTokens
  // Top-level rows (depth=0) get a wider, always-colored status border so
  // the outcome of every item is scannable at a glance. Child rows keep a
  // thinner border and only color it for running/failed (success stays quiet).
  const borderWidth = depth === 0 ? 'border-l-[3px]' : 'border-l-2'
  const accentBorder = isRunning
    ? `${borderWidth} border-l-status-info`
    : isFailed
    ? `${borderWidth} border-l-status-error`
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

        <span className={`shrink-0 mt-0.5 inline-flex items-center justify-center w-[64px] px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded ${KIND_COLOR[e.bucket]}`}>
          {KIND_LABEL[e.bucket]}
        </span>

        <div className="flex-1 min-w-0">
          <div className="text-sm text-text-primary font-medium truncate group-hover:text-accent">
            {e.title}
          </div>
          <div className="flex items-center gap-2 text-xs text-text-tertiary mt-0.5 flex-wrap">
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
            {e.model && <span className="font-mono">{e.model}</span>}
            {e.navSessionId && <span className="font-mono">#{e.navSessionId.slice(0, 8)}</span>}
            {summary && <span className="font-mono text-text-secondary">{summary}</span>}
            {e.subtitle && !summary && <span className="italic truncate">{e.subtitle}</span>}
          </div>
        </div>

        <div className="shrink-0 flex flex-col items-end gap-0.5 text-xs">
          {(totalTokens > 0 || e.costUsd > 0) && (
            <div className="flex items-center gap-2">
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
              <span className="font-mono text-text-secondary">
                {formatDuration(e.startedAt, e.finishedAt)}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            {totalTokens === 0 && e.costUsd === 0 && (
              <span className="font-mono text-text-secondary">
                {formatDuration(e.startedAt, e.finishedAt)}
              </span>
            )}
            <span className="text-text-tertiary text-[11px]">{formatAgo(e.lastActivityAt)}</span>
            {e.logPruned && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-text-tertiary/15 text-text-tertiary" title="Log file deleted by retention policy">
                pruned
              </span>
            )}
            <VerdictBadge verdict={e.verdict} isRunning={isRunning} isFailed={isFailed} exitCode={e.exitCode} />
          </div>
        </div>
      </div>
      {children}
    </div>
  )
}
