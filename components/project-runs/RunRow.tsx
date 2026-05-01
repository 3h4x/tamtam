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
const DEPTH_PADDING: Record<number, string> = {
  0: 'pl-4',
  1: 'pl-12',
  2: 'pl-20',
  3: 'pl-28',
  4: 'pl-36',
  5: 'pl-44',
  6: 'pl-52',
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
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
      isRunning ? 'bg-status-warning/15 text-status-warning' :
      isFailed ? 'bg-status-error/15 text-status-error' :
      'bg-status-success/15 text-status-success'
    }`}>
      <span className={isRunning ? 'animate-pulse' : ''}>●</span>
      {isRunning ? 'running' : isFailed ? `exit ${exitCode}` : 'done'}
    </span>
  )
}

export function RunRow({ entry: e, onClick, expandable, expanded, onToggleExpand, summary, depth = 0, children }: RunRowProps) {
  const isRunning = e.status === 'running'
  const isFailed = !isRunning && e.exitCode !== null && e.exitCode !== 0
  const totalTokens = e.inputTokens + e.outputTokens
  const accentBorder = isRunning
    ? 'border-l-2 border-l-status-warning'
    : isFailed
    ? 'border-l-2 border-l-status-error'
    : 'border-l-2 border-l-transparent'
  const paddingLeft = DEPTH_PADDING[Math.min(depth, 6)] ?? 'pl-52'

  // Connector glyphs for nested rows. The vertical pipes show the chain
  // walking down through ancestor depths; the angled `└─` puts the row
  // visually under its direct parent. Rendered as absolute-positioned spans
  // so they don't fight the existing flex layout.
  const connectors: React.ReactNode = depth > 0 ? (
    <span aria-hidden className="absolute left-0 top-0 bottom-0 pointer-events-none select-none font-mono text-text-tertiary/50 text-[12px]">
      {Array.from({ length: depth - 1 }).map((_, i) => (
        <span key={i} className="absolute top-0 bottom-0 border-l border-border/50" style={{ left: `${20 + i * 32}px` }} />
      ))}
      <span className="absolute border-l border-border/50" style={{ left: `${20 + (depth - 1) * 32}px`, top: 0, height: '50%' }} />
      <span className="absolute border-t border-border/50" style={{ left: `${20 + (depth - 1) * 32}px`, top: '50%', width: '12px' }} />
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
                className="font-mono text-text-tertiary"
                title={`Started by ${e.parentLabel} (${e.parentJobId?.slice(-12) ?? ''})`}
              >
                ← {e.parentLabel}
              </span>
            )}
            {e.turns > 1 && <span className="font-mono">{e.turns} turns</span>}
            {e.model && <span className="font-mono">{e.model}</span>}
            {e.navSessionId && <span className="font-mono">#{e.navSessionId.slice(0, 8)}</span>}
            {summary && <span className="font-mono text-text-secondary">{summary}</span>}
            {e.subtitle && !summary && <span className="italic truncate">{e.subtitle}</span>}
          </div>
        </div>

        {totalTokens > 0 || e.costUsd > 0 ? (
          <div className="shrink-0 flex flex-col items-end gap-0.5 text-xs">
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
            <div className="flex items-center gap-2">
              <span className="text-text-tertiary text-[11px]">{formatAgo(e.lastActivityAt)}</span>
              {e.logPruned && (
                <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-text-tertiary/15 text-text-tertiary" title="Log file deleted by retention policy">
                  pruned
                </span>
              )}
              <VerdictBadge verdict={e.verdict} isRunning={isRunning} isFailed={isFailed} exitCode={e.exitCode} />
            </div>
          </div>
        ) : (
          <div className="shrink-0 flex items-center gap-2 text-xs">
            <span className="font-mono text-text-secondary">
              {formatDuration(e.startedAt, e.finishedAt)}
            </span>
            <span className="text-text-tertiary text-[11px]">{formatAgo(e.lastActivityAt)}</span>
            {e.logPruned && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-text-tertiary/15 text-text-tertiary" title="Log file deleted by retention policy">
                pruned
              </span>
            )}
            <VerdictBadge verdict={e.verdict} isRunning={isRunning} isFailed={isFailed} exitCode={e.exitCode} />
          </div>
        )}
      </div>
      {children}
    </div>
  )
}
