'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { mergePR, approvePR, reviewPR, runMarkDod } from '@/lib/client-api'
import type { GhPullRequest } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { Labels, CheckIcon, GateBadge } from '@/components/issues-tab/shared'
import type { MergeMethod, PrGates } from '@/components/issues-tab/shared'

export function PRRow({ pr, projectName, onMerged }: { pr: GhPullRequest; projectName: string; onMerged: () => void }) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [checksExpanded, setChecksExpanded] = useState(false)
  const [mergeConfirm, setMergeConfirm] = useState(false)
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>('squash')
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [merged, setMerged] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approved, setApproved] = useState(pr.reviewDecision === 'APPROVED')
  const [reviewing, setReviewing] = useState(false)
  const [gates, setGates] = useState<PrGates | null>(null)
  const [dodRunning, setDodRunning] = useState(false)
  const [dodError, setDodError] = useState<string | null>(null)

  // Fetch TamTam-side gate state (tests / review / DoD) for this PR.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const repoMatch = pr.url.match(/github\.com\/([^/]+\/[^/]+)\//)
        const repo = repoMatch?.[1] ?? ''
        const qs = new URLSearchParams({ body: pr.body ?? '', repo })
        const res = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/pr-gates?${qs.toString()}`)
        if (!res.ok) return
        const data: PrGates = await res.json()
        if (!cancelled) setGates(data)
      } catch {}
    }
    load()
    return () => { cancelled = true }
  }, [projectName, pr.number, pr.url, pr.body])

  const reviewLabel =
    pr.reviewDecision === 'APPROVED'
      ? 'Approved'
      : pr.reviewDecision === 'CHANGES_REQUESTED'
      ? 'Changes requested'
      : pr.reviewDecision === 'REVIEW_REQUIRED'
      ? 'Review required'
      : null

  const checks = pr.statusCheckRollup ?? []
  const passCount = checks.filter(c => c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED').length
  const ciRollup = checks.length === 0 ? null
    : checks.some(c => c.status !== 'COMPLETED') ? 'PENDING'
    : checks.some(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.conclusion === 'TIMED_OUT') ? 'FAILURE'
    : checks.every(c => c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED') ? 'SUCCESS'
    : 'FAILURE'

  const ciBadgeClass =
    ciRollup === 'SUCCESS' ? 'bg-status-success/10 text-status-success border-status-success/30'
    : ciRollup === 'FAILURE' ? 'bg-status-error/10 text-status-error border-status-error/30'
    : ciRollup === 'PENDING' ? 'bg-status-warning/10 text-status-warning border-status-warning/30'
    : null

  const [switchingBranch, setSwitchingBranch] = useState(false)

  const openInTerminal = async () => {
    setSwitchingBranch(true)
    try {
      await fetch(`/api/projects/by-project/${projectName}/pr-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: pr.headRefName }),
      })
    } finally {
      setSwitchingBranch(false)
    }
    const prompt = `Review pull request #${pr.number}: "${pr.title}" (${pr.url})\n\nBranch: ${pr.headRefName} → ${pr.baseRefName}`
    const key = `tamtam-pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    try { sessionStorage.setItem(key, JSON.stringify({ prompt })) } catch {}
    router.push(`/project/${projectName}/terminal?pending=${key}`)
  }

  const runDod = async () => {
    if (!gates) return
    setDodRunning(true)
    setDodError(null)
    try {
      const repoMatch = pr.url.match(/github\.com\/([^/]+\/[^/]+)\//)
      const repo = repoMatch?.[1] ?? ''
      // Prefer the linked issue (mark-dod ticks issue checkboxes); fall back
      // to the PR itself when there's no issue ref in the body.
      const ctx = gates.issueNumber
        ? { issue_number: gates.issueNumber, repo }
        : { pr_number: pr.number, repo }
      const result = await runMarkDod(projectName, ctx)
      router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(result.jobId)}`)
    } catch (err) {
      setDodError(err instanceof Error ? err.message : 'DoD verification failed')
    } finally {
      setDodRunning(false)
    }
  }

  const doReview = async () => {
    setReviewing(true)
    try {
      const res = await reviewPR(projectName, pr.number, pr.title, pr.headRefName, pr.baseRefName)
      router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(res.job_id)}`)
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Review failed')
    } finally {
      setReviewing(false)
    }
  }

  const doMerge = async () => {
    setMerging(true)
    setMergeError(null)
    try {
      await mergePR(projectName, pr.number, mergeMethod)
      setMerged(true)
      setMergeConfirm(false)
      setTimeout(onMerged, 800)
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Merge failed')
      setMergeConfirm(false)
    } finally {
      setMerging(false)
    }
  }

  const doApprove = async () => {
    setApproving(true)
    setMergeError(null)
    try {
      await approvePR(projectName, pr.number)
      setApproved(true)
      // Refresh from server so reviewDecision reflects reality.
      setTimeout(onMerged, 500)
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Approve failed')
    } finally {
      setApproving(false)
    }
  }

  const needsApproval = !approved
    && pr.reviewDecision !== 'APPROVED'
    && pr.reviewDecision !== 'CHANGES_REQUESTED'

  return (
    <div className={`border-b border-border last:border-b-0 transition-opacity ${merged ? 'opacity-50' : ''}`}>
      <div className="px-3 py-2 flex items-start gap-2.5 hover:bg-bg-tertiary/50 transition-colors">
        <span className={`mt-1 shrink-0 ${pr.isDraft ? 'text-text-tertiary' : 'text-status-success'}`} title={pr.isDraft ? 'Draft PR' : 'Open PR'}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 flex-wrap">
            <button
              className="text-sm text-text-primary font-medium hover:text-accent text-left cursor-pointer"
              onClick={() => setExpanded((v) => !v)}
            >
              {pr.title}
            </button>
            {merged && (
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-status-success/15 text-status-success border border-status-success/30 font-medium">
                Merged
              </span>
            )}
            {pr.isDraft && (
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-bg-tertiary text-text-secondary border border-border font-medium">
                Draft
              </span>
            )}
            <Labels labels={pr.labels} />
          </div>
          <div className="flex items-center gap-x-2 gap-y-1 mt-1 flex-wrap text-xs text-text-tertiary tabular-nums">
            <span className="font-mono">#{pr.number}</span>
            <span className="text-border">·</span>
            <span>{pr.author?.login}</span>
            <span className="text-border">·</span>
            <span title={pr.createdAt}>{formatAgo(new Date(pr.createdAt).getTime() / 1000)}</span>
            <span className="text-border">·</span>
            <code className="font-mono bg-bg-tertiary px-1.5 py-0.5 rounded text-[10px] text-text-secondary">{pr.headRefName}</code>
            {reviewLabel && (
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${
                pr.reviewDecision === 'APPROVED' ? 'bg-status-success/10 text-status-success border-status-success/30'
                : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'bg-status-error/10 text-status-error border-status-error/30'
                : 'bg-bg-tertiary text-text-secondary border-border'
              }`}>{reviewLabel}</span>
            )}
            {gates && (
              <>
                <GateBadge label="tests" state={gates.tests} title={`TamTam tests: ${gates.tests}`} />
                <GateBadge label="review" state={gates.review} title={`AI review verdict: ${gates.review === 'pass' ? 'LGTM' : gates.review === 'warn' ? 'NEEDS ATTENTION' : gates.review === 'fail' ? 'DO NOT SHIP / failed' : 'not run'}`} />
                <GateBadge
                  label={gates.dodSummary ?? 'DoD'}
                  state={gates.dod}
                  title={
                    gates.dod === 'none'
                      ? 'No acceptance criteria found in PR body'
                      : `Click to verify acceptance criteria${gates.issueNumber ? ` for #${gates.issueNumber}` : ''} (${gates.dodSummary ?? gates.dod})`
                  }
                  onClick={gates.dod === 'none' ? undefined : runDod}
                  busy={dodRunning}
                />
              </>
            )}
            {ciRollup && ciBadgeClass && (
              <button
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border cursor-pointer transition-colors hover:opacity-80 ${ciBadgeClass}`}
                onClick={e => { e.stopPropagation(); setChecksExpanded(v => !v) }}
                title={checksExpanded ? 'Hide checks' : 'Show checks'}
              >
                <CheckIcon conclusion={ciRollup === 'SUCCESS' ? 'SUCCESS' : ciRollup === 'FAILURE' ? 'FAILURE' : null} status={ciRollup === 'PENDING' ? 'PENDING' : 'COMPLETED'} />
                {passCount}/{checks.length} checks
                <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor" className={`transition-transform ${checksExpanded ? 'rotate-180' : ''}`}>
                  <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
                </svg>
              </button>
            )}
          </div>
          {checksExpanded && checks.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-0.5 ml-0">
              {checks.map((c, i) => {
                const ok = c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED'
                const pending = c.status !== 'COMPLETED'
                const dotCls = pending ? 'bg-status-warning' : ok ? 'bg-status-success' : 'bg-status-error'
                return (
                  <a
                    key={i}
                    href={c.detailsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[10px] text-text-secondary hover:text-text-primary hover:bg-bg-tertiary rounded px-1 py-0.5 -mx-1 transition-colors"
                    onClick={e => e.stopPropagation()}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotCls}`} />
                    <span className="font-medium">{c.workflowName || c.name}</span>
                    {c.workflowName && c.name !== c.workflowName && (
                      <span className="text-text-tertiary">/ {c.name}</span>
                    )}
                    <span className={`ml-auto ${ok ? 'text-status-success' : pending ? 'text-status-warning' : 'text-status-error'}`}>
                      {pending ? c.status.toLowerCase() : (c.conclusion ?? '').toLowerCase()}
                    </span>
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" className="text-text-tertiary shrink-0">
                      <path d="M10.604 1h4.146a.25.25 0 01.25.25v4.146a.25.25 0 01-.427.177L13.03 4.03 9.28 7.78a.75.75 0 01-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0110.604 1zM3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"/>
                    </svg>
                  </a>
                )
              })}
            </div>
          )}
          {mergeError && (
            <div className="mt-1 text-xs text-status-error">{mergeError}</div>
          )}
          {dodError && (
            <div className="mt-1 text-xs text-status-error">DoD: {dodError}</div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!merged && needsApproval && (
            <button
              className="px-2 py-1 text-xs border border-accent/50 rounded-md bg-accent/10 text-accent hover:bg-accent/20 cursor-pointer disabled:opacity-50"
              onClick={doApprove}
              disabled={approving}
              title="Submit an APPROVE review (required by branch protection before merge)"
            >
              {approving ? 'Approving…' : 'Approve'}
            </button>
          )}
          {!merged && (
            mergeConfirm ? (
              <div className="flex items-center gap-1">
                <select
                  className="px-1.5 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary cursor-pointer"
                  value={mergeMethod}
                  onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
                  disabled={merging}
                >
                  <option value="squash">squash</option>
                  <option value="merge">merge</option>
                  <option value="rebase">rebase</option>
                </select>
                <button
                  className="px-2 py-1 text-xs bg-status-success text-white rounded-md hover:opacity-90 cursor-pointer disabled:opacity-50 font-medium"
                  onClick={doMerge}
                  disabled={merging}
                >
                  {merging ? 'Merging…' : 'Confirm'}
                </button>
                <button
                  className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-secondary hover:bg-bg-tertiary cursor-pointer"
                  onClick={() => setMergeConfirm(false)}
                  disabled={merging}
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                className="px-2 py-1 text-xs border border-status-success/50 rounded-md bg-status-success/10 text-status-success hover:bg-status-success/20 cursor-pointer"
                onClick={() => setMergeConfirm(true)}
                title="Merge this PR"
              >
                Merge
              </button>
            )
          )}
          {!merged && (
            <button
              className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50"
              onClick={doReview}
              disabled={reviewing}
              title="AI code review of this PR's diff"
            >
              {reviewing ? 'Starting…' : 'Review'}
            </button>
          )}
          <button
            className="p-1.5 text-text-secondary hover:text-text-primary border border-border rounded-md bg-bg-secondary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 flex items-center justify-center"
            onClick={openInTerminal}
            disabled={switchingBranch}
            title={`Open in Terminal (switches to ${pr.headRefName})`}
            aria-label="Open in Terminal"
          >
            {switchingBranch ? (
              <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 2.75A.75.75 0 012.75 2h10.5a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75H2.75a.75.75 0 01-.75-.75V2.75zM3.5 3.5v9h9v-9h-9zm1.85 1.94a.75.75 0 011.06.02l2.25 2.25a.75.75 0 010 1.06l-2.25 2.25a.75.75 0 11-1.06-1.06L7.04 8 5.33 6.25a.75.75 0 01-.02-1.06l.04-.04zM8.5 10h3a.75.75 0 010 1.5h-3a.75.75 0 010-1.5z"/>
              </svg>
            )}
          </button>
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 text-text-tertiary hover:text-text-primary border border-border rounded-md bg-bg-secondary hover:bg-bg-tertiary flex items-center justify-center"
            title="Open pull request on GitHub"
            aria-label="Open on GitHub"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.604 1h4.146a.25.25 0 01.25.25v4.146a.25.25 0 01-.427.177L13.03 4.03 9.28 7.78a.75.75 0 01-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0110.604 1zM3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"/>
            </svg>
          </a>
        </div>
      </div>
      {expanded && pr.body && (
        <div className="px-10 pb-3 text-xs text-text-secondary whitespace-pre-wrap max-h-48 overflow-y-auto border-t border-border/50 bg-bg-primary">
          {pr.body}
        </div>
      )}
    </div>
  )
}
