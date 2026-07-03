'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ISSUE_FORMAT_INSTRUCTION } from '@/lib/agents/issue-template'
import { fetchAgents, fetchIssuesAndPRs, fetchProjectConfig, runAgent } from '@/lib/client-api'
import type { Agent, GhPullRequest, GhIssue, ProjectConfig } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'
import { ErrorState } from './ErrorState'
import { PRRow } from '@/components/issues-tab/PRRow'
import { IssueRow } from '@/components/issues-tab/IssueRow'
import { IssueDetailDrawer } from '@/components/issues-tab/IssueDetailDrawer'
import { PRDetailDrawer } from '@/components/issues-tab/PRDetailDrawer'
import { useToast } from '@/components/Toast'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { InlineLoading } from '@/components/ui/InlineLoading'
import { Pill, PillButton } from '@/components/ui/Pill'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Textarea } from '@/components/ui/Textarea'

export type { GhPullRequest, GhIssue, ProjectConfig }

type IssueSort = 'priority' | 'newest' | 'oldest'
type IssueFacet = 'all' | 'high' | 'medium' | 'enhancement' | 'tech-debt'

function issueLabelNames(issue: GhIssue): string[] {
  return issue.labels.map((l) => l.name.toLowerCase())
}

// 0 = highest priority. Mirrors the label→tone mapping used for the label dots.
function issuePriorityRank(issue: GhIssue): number {
  const names = issueLabelNames(issue)
  if (names.some((x) => /priority:\s*high|(^|[^a-z])(high|critical|urgent|blocker|p0)([^a-z]|$)/.test(x))) return 0
  if (names.some((x) => /priority:\s*medium|(^|[^a-z])(medium|p1)([^a-z]|$)/.test(x))) return 1
  if (names.some((x) => /priority:\s*low|(^|[^a-z])(low|p2)([^a-z]|$)/.test(x))) return 2
  return 3
}

function issueMatchesFacet(issue: GhIssue, facet: IssueFacet): boolean {
  if (facet === 'all') return true
  if (facet === 'high') return issuePriorityRank(issue) === 0
  if (facet === 'medium') return issuePriorityRank(issue) === 1
  const names = issueLabelNames(issue)
  if (facet === 'enhancement') return names.some((x) => x.includes('enhancement') || x.includes('feature'))
  return names.some((x) => x.includes('tech-debt') || x.includes('tech debt') || x.includes('chore') || x.includes('refactor'))
}

interface IssuesTabProps {
  projectName: string
  onCountChange?: (count: { prs: number; issues: number }) => void
  jobsPaused?: boolean
}

export function IssuesTab({ projectName, onCountChange, jobsPaused = false }: IssuesTabProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { toast } = useToast()
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
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [ctoAgent, setCtoAgent] = useState<Agent | null>(null)
  const [issueDraft, setIssueDraft] = useState('')
  const [planning, setPlanning] = useState(false)
  const [issueSearch, setIssueSearch] = useState('')
  const [issueSort, setIssueSort] = useState<IssueSort>('priority')
  const [issueFacet, setIssueFacet] = useState<IssueFacet>('all')

  const visibleIssues = useMemo(() => {
    const q = issueSearch.trim().toLowerCase()
    const filtered = issues.filter((i) => {
      if (!issueMatchesFacet(i, issueFacet)) return false
      if (!q) return true
      return i.title.toLowerCase().includes(q) || String(i.number).includes(q)
    })
    const sorted = [...filtered]
    if (issueSort === 'priority') sorted.sort((a, b) => issuePriorityRank(a) - issuePriorityRank(b) || b.number - a.number)
    else if (issueSort === 'newest') sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    else sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    return sorted
  }, [issues, issueSearch, issueSort, issueFacet])
  // Deep-linkable issue detail: ?issue=<number> selects an open issue and
  // opens the slide-over. Mirrors the History tab's ?job= drawer wiring.
  const selectedIssue = useMemo(() => {
    const n = searchParams?.get('issue')
    if (!n) return null
    return issues.find((i) => String(i.number) === n) ?? null
  }, [searchParams, issues])
  const updateSelectedIssue = useCallback((num: number | null) => {
    const next = new URLSearchParams(searchParams?.toString() ?? '')
    if (num != null) next.set('issue', String(num))
    else next.delete('issue')
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }, [pathname, router, searchParams])
  const selectedPr = useMemo(() => {
    const n = searchParams?.get('pr')
    if (!n) return null
    return prs.find((p) => String(p.number) === n) ?? null
  }, [searchParams, prs])
  const updateSelectedPr = useCallback((num: number | null) => {
    const next = new URLSearchParams(searchParams?.toString() ?? '')
    if (num != null) next.set('pr', String(num))
    else next.delete('pr')
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }, [pathname, router, searchParams])
  const onCountChangeRef = useRef(onCountChange)
  const trimmedIssueDraft = issueDraft.trim()
  const issuePlanningBlocked = jobsPaused || agentsLoading || planning || !ctoAgent || trimmedIssueDraft.length < 10
  const issuePlanningTitle = jobsPaused
    ? 'Jobs are paused globally. Resume jobs to plan an issue.'
    : 'Cmd/Ctrl+Enter'

  useEffect(() => {
    onCountChangeRef.current = onCountChange
  }, [onCountChange])

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
      onCountChangeRef.current?.({ prs: res.prs.length, issues: res.issues.length })
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

  useEffect(() => {
    let cancelled = false
    setAgentsLoading(true)
    fetchAgents(projectName)
      .then(({ agents }) => {
        if (cancelled) return
        setCtoAgent(agents.find(agent =>
          agent.name.toLowerCase() === 'cto' || agent.skillIds.includes('agent-cto')
        ) ?? null)
      })
      .catch(() => {
        if (!cancelled) setCtoAgent(null)
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false)
      })
    return () => { cancelled = true }
  }, [projectName])

  const handlePlanIssue = async () => {
    const idea = trimmedIssueDraft
    if (planning) return
    if (jobsPaused) {
      toast('Jobs are paused. Resume jobs before planning an issue.', 'error')
      return
    }
    if (!ctoAgent || idea.length < 10) return

    const wrappedPrompt = `Plan a single GitHub issue for the user's idea below. Read CLAUDE.md, README.md if present, and relevant docs/*.md files so the issue matches current project direction. Run \`gh issue list --limit 50 --state open\` and search the repo for the idea's key nouns/routes/components before filing; if it is already implemented, already tracked, or in progress, report that and do not create an issue. Then file ONE issue with \`gh issue create\` - title states the outcome, labels include type + priority. If this needs a human-owned external account, vendor setup, billing, secret, approval, or credentials before code can proceed, add/create the \`human-needed\` label and make that prerequisite explicit in the Proposed approach. Do not run \`git\`. Do not modify any files.

${ISSUE_FORMAT_INSTRUCTION}

User idea:
${idea}`

    setPlanning(true)
    try {
      const result = await runAgent(ctoAgent.id, wrappedPrompt, { readOnly: true })
      if (result.status === 'queued') {
        toast(result.detail || `Agent ${ctoAgent.name} queued`, 'success')
        return
      }
      toast(`Agent ${ctoAgent.name} started`, 'success')
      setIssueDraft('')
      router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(result.job_id)}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to plan issue', 'error')
    } finally {
      setPlanning(false)
    }
  }

  if (loading) {
    return (
      <div className="mt-2 space-y-2.5">
        <div className="rounded-md border border-border bg-bg-secondary px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="skeleton h-4 w-28" />
            <div className="skeleton h-5 w-14 rounded-full" />
            <div className="skeleton h-5 w-[4.5rem] rounded-full" />
            <div className="ml-auto skeleton h-7 w-20 rounded-md" />
          </div>
        </div>
        <div className="overflow-hidden rounded-md border border-border bg-bg-secondary">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2 border-b border-border px-3 py-2 last:border-0" style={{ opacity: 1 - i * 0.16 }}>
              <div className="skeleton h-4 w-4 rounded-full mt-0.5 shrink-0" />
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-start gap-2">
                  <div className="skeleton h-4 w-3/5" />
                  <div className="skeleton h-5 w-12 rounded-full shrink-0" />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="skeleton h-3 w-16" />
                  <div className="skeleton h-3 w-12" />
                  <div className="skeleton h-4 w-28 rounded" />
                  <div className="skeleton h-5 w-12 rounded-full" />
                </div>
              </div>
              <div className="flex items-center gap-1.5 pl-2 shrink-0">
                <div className="skeleton h-7 w-16 rounded-md" />
                <div className="skeleton h-7 w-7 rounded-md" />
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
    <div className="mt-2 space-y-2.5">
      <div className="rounded-md border border-border bg-bg-secondary px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {repo && (
                <span className="min-w-0 truncate text-xs font-mono text-text-secondary">{repo}</span>
              )}
              <Pill size="xs" className="gap-0 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary tabular-nums">
                <span className="mr-1 text-text-primary">{prs.length}</span>
                {' '}PR{prs.length === 1 ? '' : 's'}
              </Pill>
              <Pill size="xs" className="gap-0 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary tabular-nums">
                <span className="mr-1 text-text-primary">{issues.length}</span>
                {' '}issue{issues.length === 1 ? '' : 's'}
              </Pill>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-text-tertiary">
              {fromCache && cachedAt && (
                <span className="inline-flex items-center gap-1" title={new Date(cachedAt * 1000).toLocaleString()}>
                  <span className="h-1 w-1 rounded-full bg-text-tertiary/60" />
                  cached {formatAgo(cachedAt)}
                </span>
              )}
              {ghError && (
                <span className="inline-flex items-center gap-1 text-status-warning">
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                    <path d="M7 1.5L12.5 12H1.5L7 1.5z" />
                    <path d="M7 5.5v3M7 10v.5" />
                  </svg>
                  {ghError}
                </span>
              )}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto rounded-md text-[11px] font-normal disabled:opacity-60"
            onClick={() => load('refresh')}
            disabled={refreshing}
            title="Force refresh from GitHub"
          >
            {refreshing ? (
              <InlineLoading label="Refreshing…" className="!gap-1.5 !text-[11px] text-current" />
            ) : 'Refresh'}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-bg-secondary p-3">
        <div className="flex flex-wrap items-start gap-2">
          <div className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-accent/20 bg-accent/10 text-accent">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 1.5v3" />
              <path d="M8 11.5v3" />
              <path d="M1.5 8h3" />
              <path d="M11.5 8h3" />
              <path d="M4.2 4.2l1.6 1.6" />
              <path d="M10.2 10.2l1.6 1.6" />
              <path d="M11.8 4.2l-1.6 1.6" />
              <path d="M5.8 10.2l-1.6 1.6" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="text-sm font-medium text-text-primary">Plan a GitHub issue</h3>
              <p className="text-xs text-text-tertiary">
                Describe the outcome. The{' '}
                <a
                  href={`/project/${encodeURIComponent(projectName)}/agents${ctoAgent ? `?agent=${encodeURIComponent(ctoAgent.id)}` : '?agent=new&template=cto'}`}
                  className={buttonVariants({ variant: 'link', size: 'sm' })}
                >
                  cto
                </a>{' '}
                agent will shape it and file it.
              </p>
            </div>

            {!agentsLoading && !ctoAgent ? (
              <div className="mt-3 rounded-md border border-dashed border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
                Add the{' '}
                <a
                  href={`/project/${encodeURIComponent(projectName)}/agents?agent=new&template=cto`}
                  className={buttonVariants({ variant: 'link', size: 'sm', className: 'font-medium' })}
                >
                  cto agent
                </a>{' '}
                in the Agents tab to enable this.
              </div>
            ) : (
              <>
                <Textarea
                  rows={3}
                  value={issueDraft}
                  onChange={(event) => setIssueDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault()
                      if (issuePlanningBlocked) return
                      void handlePlanIssue()
                    }
                  }}
                  disabled={agentsLoading || planning || !ctoAgent}
                  fontSize="xs"
                  resize="y"
                  className="mt-3 leading-5"
                  placeholder="Add a per-project quota override on the Settings -> Pipeline tab so heavy projects can have a higher token cap than the global default."
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Pill size="xs" className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary">runs in parallel</Pill>
                  <Pill size="xs" className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary">read-only</Pill>
                  <Pill size="xs" className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary">uses cto agent</Pill>
                  <Button
                    variant="primary"
                    size="sm"
                    className="ml-auto rounded-md border-accent/30 px-2.5 py-1.5 hover:bg-accent/15"
                    onClick={() => void handlePlanIssue()}
                    disabled={issuePlanningBlocked}
                    title={issuePlanningTitle}
                  >
                    {planning ? (
                      <Spinner size="lg" />
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M8 1.5v3" />
                        <path d="M8 11.5v3" />
                        <path d="M1.5 8h3" />
                        <path d="M11.5 8h3" />
                        <path d="M4.2 4.2l1.6 1.6" />
                        <path d="M10.2 10.2l1.6 1.6" />
                        <path d="M11.8 4.2l-1.6 1.6" />
                        <path d="M5.8 10.2l-1.6 1.6" />
                      </svg>
                    )}
                    <span>{planning ? 'Planning...' : 'Plan issue'}</span>
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
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
              <PRRow
                key={pr.number}
                pr={pr}
                projectName={projectName}
                jobsPaused={jobsPaused}
                onMerged={() => load('refresh')}
                onOpen={(p) => updateSelectedPr(p.number)}
              />
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
            Issues · {visibleIssues.length === issues.length ? issues.length : `${visibleIssues.length} / ${issues.length}`}
          </div>

          {/* Toolbar: search + priority-first facets + sort. A flat 29-issue
              wall was unscannable; high-priority work now floats to the top. */}
          <div className="mb-2 mt-1 flex flex-wrap items-center gap-2">
            <input
              value={issueSearch}
              onChange={(e) => setIssueSearch(e.target.value)}
              placeholder="Search issues by title or #number…"
              className="h-7 min-w-[180px] flex-1 rounded-md border border-border bg-bg-primary px-2.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
            />
            <div className="flex items-center gap-1">
              {([['all', 'all', 'accent'], ['high', 'high', 'error'], ['medium', 'medium', 'warning'], ['enhancement', 'enhancement', 'accent'], ['tech-debt', 'tech-debt', 'accent']] as [IssueFacet, string, 'accent' | 'error' | 'warning'][]).map(([f, label, tone]) => (
                <PillButton
                  key={f}
                  type="button"
                  size="sm"
                  tone={tone}
                  active={issueFacet === f}
                  className="shrink-0 px-2 font-mono text-[10px]"
                  onClick={() => setIssueFacet(f)}
                >
                  {label}
                </PillButton>
              ))}
            </div>
            <SegmentedControl<IssueSort>
              size="xs"
              ariaLabel="Sort issues"
              options={[{ value: 'priority', label: 'priority' }, { value: 'newest', label: 'newest' }, { value: 'oldest', label: 'oldest' }]}
              value={issueSort}
              onChange={setIssueSort}
            />
          </div>

          <div className="border border-border rounded-md overflow-hidden bg-bg-secondary">
            {visibleIssues.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-text-tertiary">
                No issues match this filter.
                <button type="button" className="ml-1.5 text-accent hover:underline" onClick={() => { setIssueSearch(''); setIssueFacet('all') }}>Clear</button>
              </div>
            ) : (
              visibleIssues.map((issue) => (
                <IssueRow key={issue.number} issue={issue} projectName={projectName} projectCfg={projectCfg} onOpen={(i) => updateSelectedIssue(i.number)} />
              ))
            )}
          </div>
        </div>
      )}

      {prs.length === 0 && issues.length === 0 && !ghError && (
        <EmptyState
          bordered
          paddingY="sm"
          icon={<div className="text-3xl leading-none text-text-tertiary">✓</div>}
          title="Inbox zero"
          description="GitHub shows no open PRs or issues for this project."
          action={repo && (
            <p className="mt-1 text-xs text-text-tertiary">
              <a
                href={`https://github.com/${repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: 'link', size: 'sm', className: 'font-mono' })}
              >
                {repo} ↗
              </a>
            </p>
          )}
        />
      )}

      <IssueDetailDrawer
        issue={selectedIssue}
        projectName={projectName}
        projectCfg={projectCfg}
        onClose={() => updateSelectedIssue(null)}
      />

      <PRDetailDrawer pr={selectedPr} onClose={() => updateSelectedPr(null)} />
    </div>
  )
}
