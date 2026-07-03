'use client'

import { useMemo } from 'react'
import type { GhIssue, ProjectConfig } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { Labels, workOnChainSummary } from '@/components/issues-tab/shared'
import { useIssueActions } from '@/hooks/useIssueActions'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { Spinner } from '@/components/ui/Spinner'

export function IssueRow({
  issue,
  projectName,
  projectCfg,
  onOpen,
}: {
  issue: GhIssue
  projectName: string
  projectCfg: ProjectConfig | null
  onOpen: (issue: GhIssue) => void
}) {
  const { hasContext, continuing, openInTerminal, discussInTerminal, continueWork } = useIssueActions(issue, projectName)
  const workOnTitle = useMemo(() => workOnChainSummary(projectCfg), [projectCfg])

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
              onClick={() => onOpen(issue)}
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
    </div>
  )
}
