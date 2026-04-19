'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { fetchIssuesAndPRs, mergePR } from '@/lib/client-api'
import type { GhPullRequest, GhIssue, GhLabel } from '@/lib/client-api'
import { formatAgo } from '@/lib/format'

interface IssuesTabProps {
  projectName: string
}

function Labels({ labels }: { labels: GhLabel[] }) {
  if (!labels.length) return null
  return (
    <span className="flex items-center gap-1 flex-wrap">
      {labels.map((l) => (
        <span
          key={l.name}
          className="px-1.5 py-0.5 text-[10px] rounded-full font-medium"
          style={{ background: `#${l.color}22`, color: `#${l.color}`, border: `1px solid #${l.color}44` }}
        >
          {l.name}
        </span>
      ))}
    </span>
  )
}

type MergeMethod = 'merge' | 'squash' | 'rebase'

function PRRow({ pr, projectName, onMerged }: { pr: GhPullRequest; projectName: string; onMerged: () => void }) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [mergeConfirm, setMergeConfirm] = useState(false)
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>('squash')
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [merged, setMerged] = useState(false)

  const reviewColor =
    pr.reviewDecision === 'APPROVED'
      ? 'text-status-success'
      : pr.reviewDecision === 'CHANGES_REQUESTED'
      ? 'text-status-error'
      : 'text-text-tertiary'

  const reviewLabel =
    pr.reviewDecision === 'APPROVED'
      ? 'Approved'
      : pr.reviewDecision === 'CHANGES_REQUESTED'
      ? 'Changes requested'
      : pr.reviewDecision === 'REVIEW_REQUIRED'
      ? 'Review required'
      : null

  const openInTerminal = () => {
    const prompt = `Review pull request #${pr.number}: "${pr.title}" (${pr.url})\n\nBranch: ${pr.headRefName} → ${pr.baseRefName}`
    router.push(`/project/${projectName}/terminal?prompt=${encodeURIComponent(prompt)}`)
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

  return (
    <div className={`border-b border-border last:border-b-0 ${merged ? 'opacity-50' : ''}`}>
      <div className="px-3 py-2.5 flex items-start gap-3 hover:bg-bg-tertiary/50">
        <span className="mt-0.5 shrink-0 text-status-success" title="Open PR">
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
          <div className="flex items-center gap-3 mt-0.5 flex-wrap text-xs text-text-tertiary">
            <span>#{pr.number}</span>
            <span>by {pr.author?.login}</span>
            <span title={pr.createdAt}>{formatAgo(new Date(pr.createdAt).getTime() / 1000)}</span>
            <code className="font-mono bg-bg-tertiary px-1 rounded text-[10px]">{pr.headRefName}</code>
            {reviewLabel && <span className={reviewColor}>{reviewLabel}</span>}
          </div>
          {mergeError && (
            <div className="mt-1 text-xs text-status-error">{mergeError}</div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
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
          <button
            className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
            onClick={openInTerminal}
            title="Open in Terminal"
          >
            Terminal
          </button>
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary"
          >
            GitHub &#8599;
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

function IssueRow({ issue, projectName }: { issue: GhIssue; projectName: string }) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)

  const openInTerminal = () => {
    const prompt = `Work on GitHub issue #${issue.number}: "${issue.title}" (${issue.url})\n\n${issue.body || ''}`
    router.push(`/project/${projectName}/terminal?prompt=${encodeURIComponent(prompt)}`)
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="px-3 py-2.5 flex items-start gap-3 hover:bg-bg-tertiary/50">
        <span className="mt-0.5 shrink-0 text-status-success" title="Open Issue">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
            <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 flex-wrap">
            <button
              className="text-sm text-text-primary font-medium hover:text-accent text-left cursor-pointer"
              onClick={() => setExpanded((v) => !v)}
            >
              {issue.title}
            </button>
            <Labels labels={issue.labels} />
          </div>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap text-xs text-text-tertiary">
            <span>#{issue.number}</span>
            <span>by {issue.author?.login}</span>
            <span title={issue.createdAt}>{formatAgo(new Date(issue.createdAt).getTime() / 1000)}</span>
            {issue.assignees?.length > 0 && (
              <span>assigned to {issue.assignees.map((a) => a.login).join(', ')}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
            onClick={openInTerminal}
            title="Open in Terminal"
          >
            Terminal
          </button>
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary"
          >
            GitHub &#8599;
          </a>
        </div>
      </div>
      {expanded && issue.body && (
        <div className="px-10 pb-3 text-xs text-text-secondary whitespace-pre-wrap max-h-48 overflow-y-auto border-t border-border/50 bg-bg-primary">
          {issue.body}
        </div>
      )}
    </div>
  )
}

export function IssuesTab({ projectName }: IssuesTabProps) {
  const [prs, setPrs] = useState<GhPullRequest[]>([])
  const [issues, setIssues] = useState<GhIssue[]>([])
  const [repo, setRepo] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ghError, setGhError] = useState<string | null>(null)
  const [cachedAt, setCachedAt] = useState<number | null>(null)
  const [fromCache, setFromCache] = useState(false)

  const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'refresh') setRefreshing(true)
    setError(null)
    try {
      const res = await fetchIssuesAndPRs(projectName, mode === 'refresh')
      setPrs(res.prs)
      setIssues(res.issues)
      setRepo(res.repo)
      setGhError(res.error)
      setCachedAt(res.cachedAt)
      setFromCache(res.cached)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load issues')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [projectName])

  useEffect(() => {
    load('initial')
  }, [load])

  if (loading) {
    return <div className="text-text-secondary text-sm p-4">Loading issues and PRs...</div>
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="text-status-error text-sm mb-2">{error}</div>
        <button
          className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
          onClick={() => load('initial')}
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="mt-2">
      <div className="bg-bg-secondary rounded-lg p-3 mb-3 flex items-center gap-4 flex-wrap">
        {repo && (
          <span className="text-xs text-text-secondary font-mono">{repo}</span>
        )}
        <span className="text-xs text-text-secondary">
          <span className="font-medium text-text-primary">{prs.length}</span> open PRs
        </span>
        <span className="text-xs text-text-secondary">
          <span className="font-medium text-text-primary">{issues.length}</span> open issues
        </span>
        {fromCache && cachedAt && (
          <span className="text-xs text-text-tertiary" title={new Date(cachedAt * 1000).toLocaleString()}>
            cached {formatAgo(cachedAt)}
          </span>
        )}
        {ghError && (
          <span className="text-xs text-status-warning">{ghError}</span>
        )}
        <button
          className="ml-auto px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-60"
          onClick={() => load('refresh')}
          disabled={refreshing}
          title="Force refresh from GitHub"
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {prs.length > 0 && (
        <div className="mb-4">
          <div className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-1.5 px-1">
            Pull Requests
          </div>
          <div className="border border-border rounded-lg overflow-hidden bg-bg-secondary">
            {prs.map((pr) => (
              <PRRow key={pr.number} pr={pr} projectName={projectName} onMerged={() => load('refresh')} />
            ))}
          </div>
        </div>
      )}

      {issues.length > 0 && (
        <div>
          <div className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-1.5 px-1">
            Issues
          </div>
          <div className="border border-border rounded-lg overflow-hidden bg-bg-secondary">
            {issues.map((issue) => (
              <IssueRow key={issue.number} issue={issue} projectName={projectName} />
            ))}
          </div>
        </div>
      )}

      {prs.length === 0 && issues.length === 0 && !ghError && (
        <div className="p-6 text-center text-text-secondary">
          <p className="text-sm">No open PRs or issues.</p>
          {repo && (
            <p className="text-xs text-text-tertiary mt-1">
              <a
                href={`https://github.com/${repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                {repo} &#8599;
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
