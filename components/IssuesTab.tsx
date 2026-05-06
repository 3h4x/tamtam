'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchIssuesAndPRs, fetchProjectConfig } from '@/lib/client-api'
import type { GhPullRequest, GhIssue, ProjectConfig } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { ErrorState } from './ErrorState'
import { PRRow } from '@/components/issues-tab/PRRow'
import { IssueRow } from '@/components/issues-tab/IssueRow'

// Re-export types consumed by subcomponents so callers don't need to change
export type { GhPullRequest, GhIssue, ProjectConfig }

interface IssuesTabProps {
  projectName: string
  onCountChange?: (count: { prs: number; issues: number }) => void
}

export function IssuesTab({ projectName, onCountChange }: IssuesTabProps) {
  const [prs, setPrs] = useState<GhPullRequest[]>([])
  const [issues, setIssues] = useState<GhIssue[]>([])
  const [repo, setRepo] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ghError, setGhError] = useState<string | null>(null)
  const [cachedAt, setCachedAt] = useState<number | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [projectCfg, setProjectCfg] = useState<ProjectConfig | null>(null)

  // Preload project config so the "Work on" tooltip can show the effective
  // pipeline chain. Swallowed on error — the tooltip just falls back to a
  // generic description.
  useEffect(() => {
    let cancelled = false
    fetchProjectConfig(projectName)
      .then(cfg => { if (!cancelled) setProjectCfg(cfg) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectName])

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
      onCountChange?.({ prs: res.prs.length, issues: res.issues.length })
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
    return (
      <div className="mt-2">
        <div className="bg-bg-secondary border border-border rounded-md px-3 py-1.5 mb-2">
          <div className="flex items-center gap-3">
            <div className="skeleton h-3.5 w-32" />
            <div className="skeleton h-3.5 w-12" />
            <div className="skeleton h-3.5 w-12" />
          </div>
        </div>
        <div className="border border-border rounded-md overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-3 py-1.5 flex items-start gap-2.5 border-b border-border last:border-0" style={{ opacity: 1 - i * 0.18 }}>
              <div className="skeleton h-4 w-4 rounded-full mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <div className="skeleton h-3.5 w-3/5" />
                <div className="flex items-center gap-2">
                  <div className="skeleton h-3 w-20" />
                  <div className="skeleton h-3 w-14" />
                  <div className="skeleton h-3 w-10" />
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="skeleton h-6 w-16 rounded-md" />
                <div className="skeleton h-6 w-16 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        message={error}
        hint="GitHub data is fetched via the gh CLI. Check that gh is authenticated and the repo is a GitHub remote."
        onRetry={() => load('initial')}
      />
    )
  }

  return (
    <div className="mt-2 space-y-3">
      <div className="bg-bg-secondary border border-border rounded-md px-3 py-2 flex items-center gap-2 flex-wrap">
        {repo && (
          <span className="text-xs text-text-secondary font-mono">{repo}</span>
        )}
        <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary tabular-nums">
          <span className="mr-1 text-text-primary">{prs.length}</span>
          {' '}PR{prs.length === 1 ? '' : 's'}
        </span>
        <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary tabular-nums">
          <span className="mr-1 text-text-primary">{issues.length}</span>
          {' '}issue{issues.length === 1 ? '' : 's'}
        </span>
        {fromCache && cachedAt && (
          <span className="text-xs text-text-tertiary inline-flex items-center gap-1" title={new Date(cachedAt * 1000).toLocaleString()}>
            <span className="w-1 h-1 rounded-full bg-text-tertiary/60"/>
            cached {formatAgo(cachedAt)}
          </span>
        )}
        {ghError && (
          <span className="text-xs text-status-warning">⚠ {ghError}</span>
        )}
        <button
          className="ml-auto px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-60"
          onClick={() => load('refresh')}
          disabled={refreshing}
          title="Force refresh from GitHub"
        >
          {refreshing ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <span>Refreshing…</span>
            </span>
          ) : 'Refresh'}
        </button>
      </div>

      {prs.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider px-1 flex items-center gap-1.5">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="text-status-success shrink-0">
              <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/>
            </svg>
            Pull Requests · {prs.length}
          </div>
          <div className="border border-border rounded-md overflow-hidden bg-bg-secondary">
            {prs.map((pr) => (
              <PRRow key={pr.number} pr={pr} projectName={projectName} onMerged={() => load('refresh')} />
            ))}
          </div>
        </div>
      )}

      {issues.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider px-1 flex items-center gap-1.5">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="text-accent shrink-0">
              <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
              <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
            </svg>
            Issues · {issues.length}
          </div>
          <div className="border border-border rounded-md overflow-hidden bg-bg-secondary">
            {issues.map((issue) => (
              <IssueRow key={issue.number} issue={issue} projectName={projectName} projectCfg={projectCfg} />
            ))}
          </div>
        </div>
      )}

      {prs.length === 0 && issues.length === 0 && !ghError && (
        <div className="border border-dashed border-border rounded-md p-8 text-center">
          <div className="text-3xl text-text-tertiary mb-2 leading-none">✓</div>
          <p className="text-sm text-text-secondary font-medium">Inbox zero</p>
          <p className="text-xs text-text-tertiary mt-1">No open PRs or issues for this project.</p>
          {repo && (
            <p className="text-xs text-text-tertiary mt-3">
              <a
                href={`https://github.com/${repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono hover:text-accent transition-colors"
              >
                {repo} ↗
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
