'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { GhIssue, ProjectConfig } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { Labels } from '@/components/issues-tab/shared'

// Build the hover tooltip for the "Work on" button — an ordered list of
// steps that will actually fire, with skipped ones marked "(off)". Kept in
// sync with the Config → When you click Work on section.
function workOnChainSummary(cfg: ProjectConfig | null): string {
  const on = (b: boolean | undefined) => b === true
  const step = (label: string, enabled: boolean) => `${enabled ? '✓' : '○'} ${label}${enabled ? '' : ' (off)'}`
  const parts = [
    step('branch', cfg ? on(cfg.issue_auto_branch) : true),
    '✓ prompt',
    step('release chain', on(cfg?.release_after_run)),
    step('auto-commit', on(cfg?.auto_commit_enabled)),
    step('auto-push + PR', on(cfg?.auto_push_enabled)),
    step('auto-merge + DoD', on(cfg?.auto_pr_merge_enabled)),
  ]
  return `Work-on pipeline:\n${parts.join('\n')}\n\nChange these in Config → When you click Work on.`
}

export function IssueRow({ issue, projectName, projectCfg }: { issue: GhIssue; projectName: string; projectCfg: ProjectConfig | null }) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  // Whether a previous Claude session for this issue exists (run/fix with
  // gh_issue_number stamped + a session_id). When true we offer a "Continue"
  // button that resumes that session and prompts only for unverified DoD items.
  const [hasContext, setHasContext] = useState(false)
  const [continuing, setContinuing] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/continue-issue?issue_number=${issue.number}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { hasContext?: boolean } | null) => {
        if (!cancelled && data?.hasContext) setHasContext(true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectName, issue.number])

  // Issue bodies can be many KB. Stuffing them into the URL trips Node's
  // 8KB header limit (HTTP 431) before the terminal page even renders, so
  // we stash the payload in sessionStorage and pass only the short key.
  const stashAndOpen = (data: { prompt: string; issue_number?: string; issue_repo?: string; issue_title?: string; resume_session_id?: string }) => {
    const key = `tamtam-pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    try { sessionStorage.setItem(key, JSON.stringify(data)) } catch {}
    router.push(`/project/${projectName}/terminal?pending=${key}`)
  }

  const openInTerminal = () => {
    const prompt = `Work on GitHub issue #${issue.number}: "${issue.title}" (${issue.url})\n\n${issue.body || ''}`
    const repoMatch = issue.url.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)
    const repo = repoMatch?.[1] ?? ''
    stashAndOpen({
      prompt,
      issue_number: String(issue.number),
      issue_repo: repo,
      issue_title: issue.title,
    })
  }

  const discussInTerminal = () => {
    const prompt = `Let's discuss GitHub issue #${issue.number}: "${issue.title}" (${issue.url})\n\n${issue.body || ''}\n\nHelp me think through this issue — the requirements, edge cases, possible approaches, and any open questions.`
    stashAndOpen({ prompt })
  }

  const continueWork = async () => {
    if (continuing) return
    setContinuing(true)
    try {
      const res = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/continue-issue?issue_number=${issue.number}`)
      if (!res.ok) throw new Error('continue-issue lookup failed')
      const data = await res.json() as { sessionId: string | null; prompt: string; unverifiedCount: number }
      const repoMatch = issue.url.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)
      const repo = repoMatch?.[1] ?? ''
      stashAndOpen({
        prompt: data.prompt,
        issue_number: String(issue.number),
        issue_repo: repo,
        issue_title: issue.title,
        resume_session_id: data.sessionId ?? undefined,
      })
    } catch {
      // Fall back to a plain Work-on if the lookup failed.
      openInTerminal()
    } finally {
      setContinuing(false)
    }
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="px-3 py-2 flex items-start gap-2.5 hover:bg-bg-tertiary/50 transition-colors">
        <span className="mt-1 shrink-0 text-accent" title="Open Issue">
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
          <div className="flex items-center gap-x-2 gap-y-1 mt-1 flex-wrap text-xs text-text-tertiary tabular-nums">
            <span className="font-mono">#{issue.number}</span>
            <span className="text-border">·</span>
            <span>{issue.author?.login}</span>
            <span className="text-border">·</span>
            <span title={issue.createdAt}>{formatAgo(new Date(issue.createdAt).getTime() / 1000)}</span>
            {issue.assignees?.length > 0 && (
              <>
                <span className="text-border">·</span>
                <span>→ {issue.assignees.map((a) => a.login).join(', ')}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
            onClick={discussInTerminal}
            title="Open a discussion about this issue in the terminal (no branch created)"
          >
            Discuss
          </button>
          {hasContext ? (
            <button
              className="px-2 py-1 text-xs border border-accent/40 rounded-md bg-accent/10 text-accent hover:bg-accent/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={continueWork}
              disabled={continuing}
              title="Resume the last Claude session for this issue. Auto-prompts only the acceptance criteria still unverified."
            >
              {continuing ? 'Loading…' : 'Continue'}
            </button>
          ) : (
            <button
              className="px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
              onClick={openInTerminal}
              title={workOnChainSummary(projectCfg)}
            >
              Work on
            </button>
          )}
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 text-text-tertiary hover:text-text-primary border border-border rounded-md bg-bg-secondary hover:bg-bg-tertiary flex items-center justify-center"
            title="Open issue on GitHub"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.604 1h4.146a.25.25 0 01.25.25v4.146a.25.25 0 01-.427.177L13.03 4.03 9.28 7.78a.75.75 0 01-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0110.604 1zM3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"/>
            </svg>
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
