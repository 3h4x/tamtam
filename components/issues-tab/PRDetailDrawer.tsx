'use client'

import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GhPullRequest } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { Labels, GateBadge } from '@/components/issues-tab/shared'
import { Drawer } from '@/components/ui/Drawer'
import { Pill, type PillTone } from '@/components/ui/Pill'
import { buttonVariants } from '@/components/ui/Button'

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function reviewMeta(pr: GhPullRequest): { label: string; tone: PillTone } | null {
  switch (pr.reviewDecision) {
    case 'APPROVED': return { label: 'Approved', tone: 'success' }
    case 'CHANGES_REQUESTED': return { label: 'Changes requested', tone: 'error' }
    case 'REVIEW_REQUIRED': return { label: 'Review required', tone: 'neutral' }
    default: return null
  }
}

function PRDrawerBody({ pr }: { pr: GhPullRequest }) {
  const review = reviewMeta(pr)
  const checks = pr.statusCheckRollup ?? []
  const gates = pr.gates ?? null

  return (
    <div>
      {/* Meta strip */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[11px] text-text-tertiary tabular-nums">
        <span className="font-mono text-text-secondary">#{pr.number}</span>
        <span>by <span className="text-text-secondary">{pr.author?.login}</span></span>
        <span title={pr.createdAt}>opened {formatAgo(new Date(pr.createdAt).getTime() / 1000)}</span>
        <Pill tone={pr.isDraft ? 'neutral' : pr.state.toLowerCase() === 'merged' ? 'success' : 'success'} size="xs" className="h-5 rounded px-1.5 text-[10px] uppercase tracking-wider">
          {pr.isDraft ? 'draft' : pr.state}
        </Pill>
        {review && (
          <Pill tone={review.tone} size="xs" className="h-5 rounded px-1.5 text-[10px]">{review.label}</Pill>
        )}
      </div>

      {/* Branch */}
      <div className="border-t border-border px-4 py-2">
        <code className="font-mono text-xs text-text-secondary" title={`${pr.headRefName} → ${pr.baseRefName}`}>
          {pr.headRefName} <span className="text-text-tertiary">→</span> {pr.baseRefName}
        </code>
      </div>

      {/* Labels + gates */}
      {((pr.labels?.length ?? 0) > 0 || gates) && (
        <div className="flex flex-wrap items-center gap-1 border-t border-border px-4 py-3">
          {(pr.labels?.length ?? 0) > 0 && <Labels labels={pr.labels} />}
          {gates && (
            <>
              <GateBadge label="tests" state={gates.tests} title={`TamTam tests: ${gates.tests}`} />
              <GateBadge label="review" state={gates.review} title={`AI review verdict: ${gates.review}`} />
              <GateBadge label={gates.dodSummary ?? 'DoD'} state={gates.dod} title={gates.dod === 'none' ? 'No acceptance criteria found in PR body' : `DoD: ${gates.dodSummary ?? gates.dod}`} />
            </>
          )}
        </div>
      )}

      {/* Checks */}
      {checks.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">checks · {checks.length}</div>
          <div className="flex flex-col gap-0.5">
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
                  className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 -mx-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotCls}`} />
                  <span className="font-medium">{c.workflowName || c.name}</span>
                  {c.workflowName && c.name !== c.workflowName && (
                    <span className="text-text-tertiary">/ {c.name}</span>
                  )}
                  <span className={`ml-auto tabular-nums ${ok ? 'text-status-success' : pending ? 'text-status-warning' : 'text-status-error'}`}>
                    {pending ? c.status.toLowerCase() : (c.conclusion ?? '').toLowerCase()}
                  </span>
                </a>
              )
            })}
          </div>
        </div>
      )}

      {/* Body */}
      <div className="border-t border-border px-4 py-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">description</div>
        {pr.body ? (
          <div className="doc-markdown text-sm">
            <Markdown remarkPlugins={[remarkGfm]}>{pr.body}</Markdown>
          </div>
        ) : (
          <div className="text-xs italic text-text-tertiary">No description.</div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-4 py-3">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: 'secondary', size: 'sm' })}
        >
          Open pull request on GitHub ↗
        </a>
      </div>
    </div>
  )
}

// Deep-linkable (?pr=<number>) slide-over showing the full story of one PR:
// meta, branch, labels/gates, every check run, and the rendered body. Replaces
// PRRow's inline body expand; the row keeps its merge/approve/review actions.
export function PRDetailDrawer({ pr, onClose }: { pr: GhPullRequest | null; onClose: () => void }) {
  const title = pr ? (
    <div className="flex min-w-0 items-center gap-2">
      <span className={`shrink-0 ${pr.isDraft ? 'text-text-tertiary' : 'text-status-success'}`} aria-hidden>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
        </svg>
      </span>
      <span className="min-w-0 truncate text-sm font-semibold text-text-primary" title={pr.title}>
        {truncate(pr.title, 90)}
      </span>
    </div>
  ) : (
    <span className="text-sm font-semibold text-text-primary">Pull request detail</span>
  )

  return (
    <Drawer open={pr !== null} onClose={onClose} title={title} ariaLabel="Pull request detail">
      {pr && <PRDrawerBody pr={pr} />}
    </Drawer>
  )
}
