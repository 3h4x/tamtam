'use client'

import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GhIssue, ProjectConfig } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { useIssueActions } from '@/hooks/useIssueActions'
import { Labels, workOnChainSummary } from '@/components/issues-tab/shared'
import { Drawer } from '@/components/ui/Drawer'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { Spinner } from '@/components/ui/Spinner'

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function IssueDrawerBody({ issue, projectName, projectCfg }: { issue: GhIssue; projectName: string; projectCfg: ProjectConfig | null }) {
  const { hasContext, continuing, openInTerminal, discussInTerminal, continueWork } = useIssueActions(issue, projectName)

  return (
    <div>
      {/* Meta strip */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[11px] text-text-tertiary tabular-nums">
        <span className="font-mono text-text-secondary">#{issue.number}</span>
        <span>by <span className="text-text-secondary">{issue.author?.login}</span></span>
        <span title={issue.createdAt}>opened {formatAgo(new Date(issue.createdAt).getTime() / 1000)}</span>
        {issue.state && (
          <Pill tone={issue.state.toLowerCase() === 'open' ? 'success' : 'neutral'} size="xs" className="h-5 rounded px-1.5 text-[10px] uppercase tracking-wider">
            {issue.state}
          </Pill>
        )}
        {issue.assignees?.length > 0 && (
          <span title={issue.assignees.map((a) => a.login).join(', ')}>
            assigned {issue.assignees.map((a) => a.login).join(', ')}
          </span>
        )}
      </div>

      {/* Labels */}
      {issue.labels.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-1">
            <Labels labels={issue.labels} />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3">
        {hasContext ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="gap-1 rounded-md border-accent/40 text-xs font-normal"
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
            className="rounded-md text-xs font-normal"
            onClick={openInTerminal}
            title={workOnChainSummary(projectCfg)}
          >
            Work on
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-md border-none text-xs font-normal text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
          onClick={discussInTerminal}
          title="Open a discussion about this issue in the terminal (no branch created)"
        >
          discuss
        </Button>
        <a
          href={issue.url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'gap-1 rounded-md text-xs font-normal text-text-tertiary hover:text-text-primary' })}
          title="Open issue on GitHub"
        >
          GitHub ↗
        </a>
        {hasContext && (
          <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-text-tertiary" title="A resumable provider session exists for this issue.">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            prior session
          </span>
        )}
      </div>

      {/* Body */}
      <div className="border-t border-border px-4 py-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">description</div>
        {issue.body ? (
          <div className="doc-markdown text-sm">
            <Markdown remarkPlugins={[remarkGfm]}>{issue.body}</Markdown>
          </div>
        ) : (
          <div className="text-xs italic text-text-tertiary">No description.</div>
        )}
      </div>
    </div>
  )
}

// Deep-linkable (?issue=<number>) slide-over showing the full story of one
// issue: meta, labels, work/continue/discuss actions, and the rendered body.
// Replaces the old inline row expand so opening an issue doesn't reflow the
// list, and the URL is shareable — mirrors the History tab's run drawer.
export function IssueDetailDrawer({
  issue,
  projectName,
  projectCfg,
  onClose,
}: {
  issue: GhIssue | null
  projectName: string
  projectCfg: ProjectConfig | null
  onClose: () => void
}) {
  const title = issue ? (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-accent" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
          <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
        </svg>
      </span>
      <span className="min-w-0 truncate text-sm font-semibold text-text-primary" title={issue.title}>
        {truncate(issue.title, 90)}
      </span>
    </div>
  ) : (
    <span className="text-sm font-semibold text-text-primary">Issue detail</span>
  )

  return (
    <Drawer open={issue !== null} onClose={onClose} title={title} ariaLabel="Issue detail">
      {issue && <IssueDrawerBody issue={issue} projectName={projectName} projectCfg={projectCfg} />}
    </Drawer>
  )
}
