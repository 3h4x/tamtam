'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GhIssue, ProjectConfig } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { Labels } from '@/components/issues-tab/shared'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { Spinner } from '@/components/ui/Spinner'

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
  // Whether a previous provider session for this issue exists (run/fix with
  // gh_issue_number stamped + a session_id). When true we offer a "Continue"
  // button that resumes that session and prompts only for unverified DoD items.
  // Folded into the issues payload server-side — no per-row lookup. The
  // action-triggered `continueWork` fetch below stays a raw, always-fresh call.
  const hasContext = issue.hasContext === true
  const [continuing, setContinuing] = useState(false)

  // Issue bodies can be many KB. Stuffing them into the URL trips Node's
  // 8KB header limit (HTTP 431) before the terminal page even renders, so
  // we stash the payload in sessionStorage and pass only the short key.
  const stashAndOpen = (data: { prompt: string; issue_number?: string; issue_repo?: string; issue_title?: string; resume_session_id?: string; resume_provider?: string }) => {
    const key = `tamtam-pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    try { sessionStorage.setItem(key, JSON.stringify(data)) } catch {}
    router.push(`/project/${projectName}/terminal?pending=${key}`)
  }

  // Parsed once per issue URL — used by both `openInTerminal` and
  // `continueWork`. Title-attribute string for the Work-on button is
  // also memoized so we don't rebuild the multi-line tooltip on every
  // parent re-render across every row.
  const repo = useMemo(() => {
    const m = issue.url.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)
    return m?.[1] ?? ''
  }, [issue.url])
  const workOnTitle = useMemo(() => workOnChainSummary(projectCfg), [projectCfg])

  const openInTerminal = () => {
    const prompt = `Work on GitHub issue #${issue.number}: "${issue.title}" (${issue.url})\n\n${issue.body || ''}`
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
      const data = await res.json() as { sessionId: string | null; provider: string | null; prompt: string; unverifiedCount: number }
      stashAndOpen({
        prompt: data.prompt,
        issue_number: String(issue.number),
        issue_repo: repo,
        issue_title: issue.title,
        resume_session_id: data.sessionId ?? undefined,
        resume_provider: data.provider ?? undefined,
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
      <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2 px-3 py-2 hover:bg-bg-tertiary/50 lg:grid-cols-[16px_minmax(0,1fr)_auto] transition-colors">
        <span className="mt-0.5 shrink-0 text-accent" title="Open Issue">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
            <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
          </svg>
        </span>
        <div className="min-w-0 space-y-1.5">
          <div className="flex min-w-0 items-start gap-2">
            <Button
              type="button"
              variant="link"
              className="min-w-0 flex-1 text-sm text-text-primary font-medium hover:text-accent hover:no-underline text-left leading-5"
              onClick={() => setExpanded((v) => !v)}
              title={issue.title}
            >
              <span className="line-clamp-2">{issue.title}</span>
            </Button>
            <Pill size="xs" className="shrink-0 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono text-text-secondary tabular-nums">
              #{issue.number}
            </Pill>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-tertiary tabular-nums">
            <span className="text-text-tertiary">by <span className="text-text-secondary">{issue.author?.login}</span></span>
            <span title={issue.createdAt}>{formatAgo(new Date(issue.createdAt).getTime() / 1000)}</span>
            {issue.assignees?.length > 0 && (
              <Pill size="xs" className="max-w-[240px] truncate rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary" title={issue.assignees.map((a) => a.login).join(', ')}>
                assigned {issue.assignees.map((a) => a.login).join(', ')}
              </Pill>
            )}
          </div>
          {issue.labels.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <Labels labels={issue.labels} limit={4} />
            </div>
          )}
        </div>
        <div className="col-start-2 flex flex-wrap items-center justify-start gap-1 border-t border-border/60 pt-1.5 lg:col-start-auto lg:max-w-[280px] lg:justify-end lg:border-t-0 lg:pt-0 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-md border-none text-[10px] font-normal text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
            onClick={discussInTerminal}
            title="Open a discussion about this issue in the terminal (no branch created)"
          >
            discuss
          </Button>
          {hasContext ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="gap-1 rounded-md border-accent/40 text-[10px] font-normal"
              onClick={continueWork}
              disabled={continuing}
              title="Resume the last provider session for this issue. Auto-prompts only the acceptance criteria still unverified."
            >
              {continuing && <Spinner size="sm" shrink />}
              Continue
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-md text-[10px] font-normal"
              onClick={openInTerminal}
              title={workOnTitle}
            >
              Work on
            </Button>
          )}
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({
              variant: 'secondary',
              size: 'icon-sm',
              className: 'text-text-tertiary hover:text-text-primary',
            })}
            title="Open issue on GitHub"
            aria-label="Open issue on GitHub"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.604 1h4.146a.25.25 0 01.25.25v4.146a.25.25 0 01-.427.177L13.03 4.03 9.28 7.78a.75.75 0 01-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0110.604 1zM3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"/>
            </svg>
          </a>
        </div>
      </div>
      {expanded && issue.body && (
        <div className="doc-markdown max-h-72 overflow-y-auto border-t border-border/50 bg-bg-primary px-10 pb-3 pt-2 text-xs">
          <Markdown remarkPlugins={[remarkGfm]}>{issue.body}</Markdown>
        </div>
      )}
    </div>
  )
}
