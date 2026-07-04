'use client'

import { useState } from 'react'
import { closeIssue } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Spinner } from '@/components/ui/Spinner'

type CloseReason = 'completed' | 'not planned'

const REASON_OPTIONS: Array<{ value: CloseReason; label: string }> = [
  { value: 'completed', label: 'completed' },
  { value: 'not planned', label: 'not planned' },
]

// Operator-initiated "Close issue" control shared by the compact IssueRow and
// the roomier IssueDetailDrawer. Collapsed it is a single ghost "Close" button;
// clicking expands an inline confirm strip with a GitHub close-reason picker
// (completed = done, not planned = won't do) plus Confirm/cancel — mirroring
// PRRow's merge-confirm. On success it calls `onClosed(issueNumber)` so the
// parent can optimistically drop the row and refetch.
export function CloseIssueControl({
  projectName,
  issueNumber,
  onClosed,
}: {
  projectName: string
  issueNumber: number
  onClosed: (issueNumber: number) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState<CloseReason>('completed')
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doClose = async () => {
    setClosing(true)
    setError(null)
    try {
      await closeIssue(projectName, issueNumber, reason)
      setConfirming(false)
      onClosed(issueNumber)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Close failed')
    } finally {
      setClosing(false)
    }
  }

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="rounded-md border-none text-[10px] font-normal text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
        onClick={() => setConfirming(true)}
        title="Close this issue on GitHub"
      >
        Close
      </Button>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <SegmentedControl<CloseReason>
        size="xs"
        ariaLabel="Close reason"
        options={REASON_OPTIONS}
        value={reason}
        onChange={setReason}
        disabled={closing}
      />
      <Button
        type="button"
        variant="danger"
        size="sm"
        className="rounded-md text-[10px]"
        onClick={doClose}
        disabled={closing}
        title={`Close issue #${issueNumber} as ${reason}`}
      >
        {closing && <Spinner size="sm" shrink />}
        Close issue
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="rounded-md text-[10px] text-text-secondary"
        onClick={() => { setConfirming(false); setError(null) }}
        disabled={closing}
        aria-label="Cancel close"
      >
        ✕
      </Button>
      {error && (
        <ErrorCallout padding="none" preWrap={false} className="w-full !border-0 !bg-transparent text-[11px]">
          {error}
        </ErrorCallout>
      )}
    </div>
  )
}
