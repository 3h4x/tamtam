'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { mergePR, approvePR, reviewPR, runMarkDod, addressPrComments } from '@/lib/client-api'
import type { GhPullRequest } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { Labels, CheckIcon, GateBadge } from '@/components/issues-tab/shared'
import type { MergeMethod } from '@/components/issues-tab/shared'
import { Button, buttonVariants } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { Pill, PillButton, type PillTone } from '@/components/ui/Pill'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Spinner } from '@/components/ui/Spinner'

const MERGE_METHOD_OPTIONS: Array<{ value: MergeMethod; label: string }> = [
  { value: 'squash', label: 'squash' },
  { value: 'merge', label: 'merge' },
  { value: 'rebase', label: 'rebase' },
]

export function PRRow({
  pr,
  projectName,
  jobsPaused = false,
  onMerged,
  onOpen,
}: {
  pr: GhPullRequest
  projectName: string
  jobsPaused?: boolean
  onMerged: () => void
  onOpen: (pr: GhPullRequest) => void
}) {
  const router = useRouter()
  const [checksExpanded, setChecksExpanded] = useState(false)
  const [mergeConfirm, setMergeConfirm] = useState(false)
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>('squash')
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [merged, setMerged] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approved, setApproved] = useState(pr.reviewDecision === 'APPROVED')
  const [reviewing, setReviewing] = useState(false)
  const [addressing, setAddressing] = useState(false)
  // Gate state (tests / review / DoD) is folded into the issues payload
  // server-side — no per-row `pr-gates` request on mount.
  const gates = pr.gates ?? null
  const [dodRunning, setDodRunning] = useState(false)
  const [dodError, setDodError] = useState<string | null>(null)

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

  const ciBadgeTone: PillTone | null =
    ciRollup === 'SUCCESS' ? 'success'
    : ciRollup === 'FAILURE' ? 'error'
    : ciRollup === 'PENDING' ? 'warning'
    : null
  const reviewBadgeTone: PillTone =
    pr.reviewDecision === 'APPROVED' ? 'success'
    : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'error'
    : 'neutral'

  const [switchingBranch, setSwitchingBranch] = useState(false)

  const openInTerminal = async () => {
    setSwitchingBranch(true)
    try {
      await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/pr-branch`, {
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
    router.push(`/project/${encodeURIComponent(projectName)}/terminal?pending=${key}`)
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
      router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(result.jobId)}`)
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
      router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(res.job_id)}`)
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Review failed')
    } finally {
      setReviewing(false)
    }
  }

  const doAddressComments = async () => {
    setAddressing(true)
    setMergeError(null)
    try {
      const res = await addressPrComments(projectName, pr.number)
      router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(res.job_id)}`)
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Address review comments failed')
    } finally {
      setAddressing(false)
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
  const dodPaused = jobsPaused && gates?.dod !== 'none'

  return (
    <div className={`border-b border-border last:border-b-0 transition-opacity ${merged ? 'opacity-50' : ''}`}>
      <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2 px-3 py-2 hover:bg-bg-tertiary/50 xl:grid-cols-[16px_minmax(0,1fr)_auto] transition-colors">
        <span className={`mt-0.5 shrink-0 ${pr.isDraft ? 'text-text-tertiary' : 'text-status-success'}`} title={pr.isDraft ? 'Draft PR' : 'Open PR'}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
          </svg>
        </span>
        <div className="min-w-0 space-y-1.5">
          <div className="flex min-w-0 items-start gap-2">
            <Button
              type="button"
              variant="link"
              className="min-w-0 flex-1 text-sm text-text-primary font-medium hover:text-accent hover:no-underline text-left leading-5"
              onClick={() => onOpen(pr)}
              title={pr.title}
            >
              <span className="line-clamp-2">{pr.title}</span>
            </Button>
            <Pill tone="neutral" size="xs" className="shrink-0 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono tabular-nums">
              #{pr.number}
            </Pill>
            {merged && (
              <Pill tone="success" size="xs" className="rounded-full px-1.5 text-[10px]">
                Merged
              </Pill>
            )}
            {pr.isDraft && (
              <Pill tone="neutral" size="xs" className="rounded-full bg-bg-tertiary px-1.5 text-[10px]">
                Draft
              </Pill>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-tertiary tabular-nums">
            <span className="text-text-tertiary">by <span className="text-text-secondary">{pr.author?.login}</span></span>
            <span title={pr.createdAt}>{formatAgo(new Date(pr.createdAt).getTime() / 1000)}</span>
            <code className="max-w-[280px] truncate rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary" title={`${pr.headRefName} → ${pr.baseRefName}`}>
              {pr.headRefName} → {pr.baseRefName}
            </code>
            {reviewLabel && (
              <Pill
                tone={reviewBadgeTone}
                size="xs"
                className={`rounded-full px-1.5 text-[10px] ${
                  pr.reviewDecision === 'APPROVED' ? 'bg-status-success/10'
                  : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'bg-status-error/10'
                  : 'bg-bg-tertiary'
                }`}
              >
                {reviewLabel}
              </Pill>
            )}
          </div>
          {((pr.labels?.length ?? 0) > 0 || gates || (ciRollup && ciBadgeTone)) && (
            <div className="flex flex-wrap items-center gap-1 text-xs text-text-tertiary">
              {(pr.labels?.length ?? 0) > 0 && <Labels labels={pr.labels} limit={4} />}
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
                        : dodPaused
                          ? 'Jobs are paused globally. Resume jobs to start DoD verification.'
                          : `Click to verify acceptance criteria${gates.issueNumber ? ` for #${gates.issueNumber}` : ''} (${gates.dodSummary ?? gates.dod})`
                    }
                    onClick={gates.dod === 'none' ? undefined : runDod}
                    busy={dodRunning}
                    disabled={dodPaused}
                  />
                </>
              )}
              {ciRollup && ciBadgeTone && (
                <PillButton
                  type="button"
                  tone={ciBadgeTone}
                  size="xs"
                  active
                  className="gap-1 text-[10px] hover:opacity-80"
                  onClick={e => { e.stopPropagation(); setChecksExpanded(v => !v) }}
                  title={checksExpanded ? 'Hide checks' : 'Show checks'}
                >
                  <CheckIcon conclusion={ciRollup === 'SUCCESS' ? 'SUCCESS' : ciRollup === 'FAILURE' ? 'FAILURE' : null} status={ciRollup === 'PENDING' ? 'PENDING' : 'COMPLETED'} />
                  {passCount}/{checks.length} checks
                  <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor" className={`transition-transform ${checksExpanded ? 'rotate-180' : ''}`}>
                    <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
                  </svg>
                </PillButton>
              )}
            </div>
          )}
          {checksExpanded && checks.length > 0 && (
            <div className="ml-0 mt-1 flex flex-col gap-0.5">
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
            <ErrorCallout
              padding="none"
              preWrap={false}
              className="mt-1 !border-0 !bg-transparent text-[11px]"
            >
              {mergeError}
            </ErrorCallout>
          )}
          {dodError && (
            <ErrorCallout
              padding="none"
              preWrap={false}
              className="mt-1 !border-0 !bg-transparent text-[11px]"
            >
              DoD: {dodError}
            </ErrorCallout>
          )}
        </div>
        <div className="col-start-2 flex flex-wrap items-center justify-start gap-1 border-t border-border/60 pt-1.5 xl:col-start-auto xl:max-w-[420px] xl:justify-end xl:border-t-0 xl:pt-0 shrink-0">
          {!merged && needsApproval && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="rounded-md border-accent/50 text-[10px]"
              onClick={doApprove}
              disabled={approving}
              title="Submit an APPROVE review (required by branch protection before merge)"
            >
              {approving && <Spinner size="sm" shrink />}
              Approve
            </Button>
          )}
          {!merged && (
            mergeConfirm ? (
              <div className="flex items-center gap-1">
                <SegmentedControl
                  ariaLabel="Merge method"
                  options={MERGE_METHOD_OPTIONS}
                  value={mergeMethod}
                  onChange={setMergeMethod}
                  disabled={merging}
                />

                <Button
                  type="button"
                  variant="success-solid"
                  size="sm"
                  className="rounded-md text-[10px] hover:opacity-90"
                  onClick={doMerge}
                  disabled={merging}
                >
                  {merging && <Spinner size="sm" shrink />}
                  Confirm
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="rounded-md text-[10px] text-text-secondary"
                  onClick={() => setMergeConfirm(false)}
                  disabled={merging}
                >
                  ✕
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-md border-status-success/50 bg-status-success/10 text-[10px] text-status-success hover:bg-status-success/20"
                onClick={() => setMergeConfirm(true)}
                title="Merge this PR"
              >
                Merge
              </Button>
            )
          )}
          {!merged && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-md text-[10px]"
              onClick={doReview}
              disabled={reviewing || jobsPaused}
              title={jobsPaused ? 'Jobs are paused globally. Resume jobs to start a PR review.' : 'AI review of this PR (diff + the linked issue\'s acceptance criteria). If it passes and this project has auto-merge on, the PR merges once CI is green; a red PR raises a HITL instead.'}
            >
              {reviewing && <Spinner size="sm" shrink />}
              Review
            </Button>
          )}
          {!merged && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-md text-[10px]"
              onClick={doAddressComments}
              disabled={addressing || jobsPaused || pr.reviewDecision !== 'CHANGES_REQUESTED'}
              title={
                pr.reviewDecision !== 'CHANGES_REQUESTED'
                  ? 'No unresolved review comments (reviewer has not requested changes)'
                  : jobsPaused
                    ? 'Jobs are paused globally. Resume jobs to address review comments.'
                    : 'Have Claude address the reviewer\'s comments, push a fix, and reply on each thread'
              }
            >
              {addressing && <Spinner size="sm" shrink />}
              Address comments
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-[26px] w-[26px] justify-center gap-0 !p-0 text-text-secondary"
            onClick={openInTerminal}
            disabled={switchingBranch}
            title={`Open in Terminal (switches to ${pr.headRefName})`}
            aria-label="Open in Terminal"
          >
            {switchingBranch ? (
              <Spinner />
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 2.75A.75.75 0 012.75 2h10.5a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75H2.75a.75.75 0 01-.75-.75V2.75zM3.5 3.5v9h9v-9h-9zm1.85 1.94a.75.75 0 011.06.02l2.25 2.25a.75.75 0 010 1.06l-2.25 2.25a.75.75 0 11-1.06-1.06L7.04 8 5.33 6.25a.75.75 0 01-.02-1.06l.04-.04zM8.5 10h3a.75.75 0 010 1.5h-3a.75.75 0 010-1.5z"/>
              </svg>
            )}
          </Button>
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({
              variant: 'secondary',
              size: 'icon-sm',
              className: 'h-[26px] w-[26px] text-text-tertiary hover:text-text-primary',
            })}
            title="Open pull request on GitHub"
            aria-label="Open on GitHub"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.604 1h4.146a.25.25 0 01.25.25v4.146a.25.25 0 01-.427.177L13.03 4.03 9.28 7.78a.75.75 0 01-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0110.604 1zM3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"/>
            </svg>
          </a>
        </div>
      </div>
    </div>
  )
}
