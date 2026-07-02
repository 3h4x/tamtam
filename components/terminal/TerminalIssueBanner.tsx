'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'

type CloseReason = 'stale' | 'duplicate' | 'wontfix' | 'fixed'

interface TerminalIssueBannerProps {
  projectName: string
  issue: { number: number; repo: string; title: string }
  /** Open PR that implements this issue, resolved by the parent (branch
   *  `fix/issue-N-…` or a `Closes #N` reference), or null when none is open. */
  issuePr: { number: number; url: string } | null
  /** Called after the issue is closed so the parent can drop the session's
   *  issue context and hide this banner. */
  onClosed: () => void
}

// Banner shown above the terminal when the session is linked to a GitHub issue:
// links straight to the issue and (when one exists) the implementing PR, plus a
// "close with verdict" flow that posts findings and closes the issue. Extracted
// from TerminalTab so the terminal shell stays focused on the chat surface.
export function TerminalIssueBanner({ projectName, issue, issuePr, onClosed }: TerminalIssueBannerProps) {
  const [showClose, setShowClose] = useState(false)
  const [findings, setFindings] = useState('')
  const [reason, setReason] = useState<CloseReason>('stale')
  const [closing, setClosing] = useState(false)

  const handleClose = async () => {
    if (!issue.number || !findings.trim()) return
    setClosing(true)
    try {
      const r = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/issues/${issue.number}/close-stale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findings: findings.trim(), reason }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        alert(`Close failed: ${data.detail ?? r.statusText}`)
        return
      }
      setShowClose(false)
      setFindings('')
      onClosed()
    } finally {
      setClosing(false)
    }
  }

  return (
    <div className="px-3 py-2 border-b border-border bg-bg-secondary text-xs flex items-center gap-2 flex-wrap">
      <span className="text-text-secondary flex items-center gap-1.5 flex-wrap">
        {issue.repo ? (
          <a
            href={`https://github.com/${issue.repo}/issues/${issue.number}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
            title="Open issue on GitHub"
          >
            Issue #{issue.number}
          </a>
        ) : (
          <span>Issue #{issue.number}</span>
        )}
        {issuePr && (
          <a
            href={issuePr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-border bg-bg-primary px-1.5 py-0.5 font-mono text-[10px] text-accent hover:underline"
            title="Open pull request on GitHub"
          >
            PR #{issuePr.number} ↗
          </a>
        )}
        {issue.title ? <span className="text-text-tertiary truncate">— {issue.title}</span> : null}
      </span>
      {!showClose ? (
        <Button
          type="button"
          size="sm"
          onClick={() => setShowClose(true)}
          className="ml-auto"
          title="Close this issue with a verdict comment"
        >
          Close with verdict
        </Button>
      ) : (
        <div className="ml-auto flex items-start gap-2 w-full mt-2">
          <Select
            surface="tertiary"
            size="compact"
            value={reason}
            onChange={(e) => setReason(e.target.value as CloseReason)}
          >
            <option value="stale">stale</option>
            <option value="duplicate">duplicate</option>
            <option value="wontfix">wontfix</option>
            <option value="fixed">fixed</option>
          </Select>
          <Textarea
            value={findings}
            onChange={(e) => setFindings(e.target.value)}
            placeholder="Findings to post as a comment before closing…"
            rows={3}
            appearance="muted"
            inputSize="compact"
            fontSize="xs"
            resize="both"
            className="flex-1 !px-2 !py-1"
          />
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={!findings.trim() || closing}
              onClick={handleClose}
            >
              {closing ? 'closing…' : 'Comment + Close'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => { setShowClose(false); setFindings('') }}
            >
              cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
