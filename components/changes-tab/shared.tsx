'use client'

import type { ChangeStatus } from '@/lib/client-api'
import { ErrorCallout } from '@/components/ui/ErrorCallout'

export const STATUS_LABEL: Record<ChangeStatus, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  T: 'type changed',
}

export const STATUS_COLOR: Record<ChangeStatus, string> = {
  M: 'text-status-warning bg-status-warning/15',
  A: 'text-status-success bg-status-success/15',
  D: 'text-status-error bg-status-error/15',
  R: 'text-status-info bg-status-info/15',
  C: 'text-status-info bg-status-info/15',
  U: 'text-status-error bg-status-error/15',
  T: 'text-status-warning bg-status-warning/15',
}

const STAT_BAR_BOXES = 5

// Compact 5-box add/delete ratio bar for a file row.
export function StatBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  if (total === 0) return null
  const minAdd = additions > 0 ? 1 : 0
  const minDel = deletions > 0 ? 1 : 0
  let addBoxes = Math.round((additions / total) * STAT_BAR_BOXES)
  addBoxes = Math.max(minAdd, Math.min(addBoxes, STAT_BAR_BOXES - minDel))
  const delBoxes = deletions > 0 ? STAT_BAR_BOXES - addBoxes : 0
  const emptyBoxes = STAT_BAR_BOXES - addBoxes - delBoxes
  return (
    <span className="inline-flex gap-0.5 items-center">
      {Array.from({ length: addBoxes }).map((_, i) => (
        <span key={`a${i}`} className="w-1.5 h-1.5 bg-status-success rounded-sm" />
      ))}
      {Array.from({ length: delBoxes }).map((_, i) => (
        <span key={`d${i}`} className="w-1.5 h-1.5 bg-status-error rounded-sm" />
      ))}
      {Array.from({ length: emptyBoxes }).map((_, i) => (
        <span key={`e${i}`} className="w-1.5 h-1.5 bg-border rounded-sm" />
      ))}
    </span>
  )
}

// Inline, borderless error line for git operation failures (push/pull/switch).
export function OperationError({ message, className }: { message: string; className?: string }) {
  return (
    <ErrorCallout
      padding="none"
      preWrap={false}
      className={['border-0 bg-transparent p-0 text-xs leading-snug', className].filter(Boolean).join(' ')}
    >
      {message}
    </ErrorCallout>
  )
}
