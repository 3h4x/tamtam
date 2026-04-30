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
  indent?: boolean
  children?: React.ReactNode
}

export function RunRow({ entry: e, onClick, expandable, expanded, onToggleExpand, summary, indent, children }: RunRowProps) {
  const isRunning = e.status === 'running'
  const isFailed = !isRunning && e.exitCode !== null && e.exitCode !== 0
  const totalTokens = e.inputTokens + e.outputTokens
  const accentBorder = isRunning
    ? 'border-l-2 border-l-status-warning'
    : isFailed
    ? 'border-l-2 border-l-status-error'
    : 'border-l-2 border-l-transparent'
  // Indent must align with the parent's kind badge:
  //   parent row = pl-4 (16) + chevron (20) + gap-3 (12) = 48px before badge
  //   indented child = pl-12 (48) so its kind badge sits directly under the parent's.
  const paddingLeft = indent ? 'pl-12' : 'pl-4'

  return (
    <div className="border-b border-border last:border-b-0">
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick() } }}
        className={`w-full text-left hover:bg-bg-tertiary cursor-pointer ${paddingLeft} pr-4 py-3 flex items-start gap-3 group ${accentBorder}`}
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
            {e.parentLabel && (
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
            {e.verdict && !isRunning && !isFailed ? (
              <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full font-medium font-mono ${
                e.verdict === 'LGTM' ? 'bg-status-success/15 text-status-success border border-status-success/30' :
                e.verdict === 'DO NOT SHIP' ? 'bg-status-error/15 text-status-error border border-status-error/30' :
                'bg-status-warning/15 text-status-warning border border-status-warning/30'
              }`} title={`Review verdict: ${e.verdict}`}>
                {e.verdict === 'LGTM' ? '✓ LGTM' : e.verdict === 'DO NOT SHIP' ? '✗ DNS' : '⚠ ATTN'}
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
                isRunning ? 'bg-status-warning/15 text-status-warning' :
                isFailed ? 'bg-status-error/15 text-status-error' :
                'bg-status-success/15 text-status-success'
              }`}>
                <span className={isRunning ? 'animate-pulse' : ''}>●</span>
                {isRunning ? 'running' : isFailed ? `exit ${e.exitCode}` : 'done'}
              </span>
            )}
          </div>
        </div>
      </div>
      {children}
    </div>
  )
}
