'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { fetchJobs } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'
import { jobIsAborted, jobIsRunning, jobNeedsAttention, jobSucceeded } from '@/lib/client/job-status'
import { formatAgo } from '@/lib/shared/format'
import { MetaChip } from '@/components/MetaChip'

// Initial page size and how many additional rows each scroll batch loads.
// Kept generous enough that a single batch covers a typical viewport so
// the user doesn't see a "loading more" flicker after every screen.
const PAGE_SIZE = 50

function formatDuration(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt || Date.now() / 1000
  const s = Math.floor(end - startedAt)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function formatTokens(job: JobInfo): string | null {
  const total = (job.input_tokens ?? 0) + (job.output_tokens ?? 0)
  if (!total) return null
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k tok`
  return `${total} tok`
}

function formatCost(job: JobInfo): string | null {
  const c = job.cost_usd
  if (c == null || c === 0) return null
  if (c < 0.0001) return '<$0.0001'
  if (c < 0.01) return `$${c.toFixed(4)}`
  return `$${c.toFixed(2)}`
}

function formatTokenPair(job: JobInfo): string | null {
  const input = job.input_tokens ?? 0
  const output = job.output_tokens ?? 0
  if (!input && !output) return null
  const compact = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`)
  return `↑${compact(input)} ↓${compact(output)}`
}

function getJobStatus(job: JobInfo): {
  isRunning: boolean
  isFailed: boolean
  border: string
  badge: string
  badgeClass: string
} {
  const isRunning = jobIsRunning(job)
  const isAborted = jobIsAborted(job)
  const isFailed = jobNeedsAttention(job)
  return {
    isRunning,
    isFailed,
    border: isRunning ? 'border-l-status-info' : isFailed ? 'border-l-status-error' : 'border-l-status-success',
    badge: isRunning ? 'running' : isAborted ? 'cancelled' : isFailed ? `exit ${job.exit_code}` : 'done',
    badgeClass: isRunning
      ? 'border-status-info/30 bg-status-info/15 text-status-info'
      : isFailed
        ? 'border-status-error/30 bg-status-error/15 text-status-error'
        : 'border-status-success/30 bg-status-success/15 text-status-success',
  }
}

function promptPreview(job: JobInfo): string | null {
  const promptText = job.user_prompt ?? job.prompt ?? null
  if (promptText) return promptText.split('\n')[0].trim()
  if (job.work_summary) return job.work_summary
  return KIND_HINTS[job.kind] ?? null
}

// Short descriptive hint shown in the Prompt column when a pipeline job has no
// user-visible prompt (review, commit, push, etc.).
const KIND_HINTS: Record<string, string> = {
  review: 'code review',
  commit: 'generate commit',
  push: 'git push',
  test: 'run tests',
  fix: 'apply fixes',
  'fix-ci': 'fix CI failures',
  'fix-push': 'fix push error',
  'mark-dod': 'verify DoD',
  'pr-wait': 'wait for CI & merge',
  release: 'release pipeline',
}

// Mirror ProjectRunsTab color/label mapping so kind badges look the same
// across the global Runs view and project-scoped runs.
const KIND_STYLES: Record<string, { label: string; cls: string }> = {
  run: { label: 'chat', cls: 'bg-accent/15 text-accent' },
  release: { label: 'release', cls: 'bg-accent/20 text-accent border border-accent/40' },
  review: { label: 'review', cls: 'bg-status-info/15 text-status-info' },
  test: { label: 'test', cls: 'bg-status-success/15 text-status-success' },
  fix: { label: 'fix', cls: 'bg-status-warning/15 text-status-warning' },
  'fix-ci': { label: 'fix-ci', cls: 'bg-status-warning/15 text-status-warning' },
  'fix-push': { label: 'fix-push', cls: 'bg-status-warning/15 text-status-warning' },
  commit: { label: 'commit', cls: 'bg-status-success/15 text-status-success' },
  push: { label: 'push', cls: 'bg-status-success/15 text-status-success' },
  'mark-dod': { label: 'dod', cls: 'bg-status-info/15 text-status-info' },
  'pr-wait': { label: 'pr-wait', cls: 'bg-status-info/15 text-status-info' },
}

function KindBadge({ kind }: { kind: string }) {
  const isAgent = kind.startsWith('agent:')
  const style = KIND_STYLES[kind]
  const label = isAgent ? kind.slice('agent:'.length) || 'agent' : style?.label ?? kind
  const cls = isAgent
    ? 'bg-bg-tertiary text-text-secondary border border-border'
    : style?.cls ?? 'bg-text-tertiary/15 text-text-secondary'
  return (
    <span
      className={`inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded ${cls}`}
      title={kind}
    >
      {label}
    </span>
  )
}

function VerdictBadge({ verdict }: { verdict: NonNullable<JobInfo['verdict']> }) {
  const cls =
    verdict === 'LGTM'
      ? 'bg-status-success/15 text-status-success border-status-success/30'
      : verdict === 'DO NOT SHIP'
      ? 'bg-status-error/15 text-status-error border-status-error/30'
      : 'bg-status-warning/15 text-status-warning border-status-warning/30'
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full font-mono font-medium border ${cls}`}
      title={`Review verdict: ${verdict}`}
    >
      {verdict === 'LGTM' ? '✓ LGTM' : verdict === 'DO NOT SHIP' ? '✗ DNS' : '⚠ ATTN'}
    </span>
  )
}

export function JobsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const projectFilter = searchParams.get('project')
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'running' | 'done' | 'failed'>('all')
  const [search, setSearch] = useState('')
  // How many rows to request from the server. Starts at one page; each time
  // the sentinel scrolls into view we bump by another page. The polling
  // effect re-runs whenever this changes so already-loaded rows refresh
  // alongside any newly-added ones.
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE)
  // Whether the last response returned fewer rows than requested — that's
  // the signal that we've reached the end of the dataset.
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [boardUrl, setBoardUrl] = useState<string>('')

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        const s = data?.settings ?? data
        if (s?.github_board_sync_enabled === 'true') {
          const url = (typeof s?.github_board_view_url === 'string' && s.github_board_view_url) || (typeof s?.github_board_project_url === 'string' ? s.github_board_project_url : '')
          if (url) setBoardUrl(url)
        }
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let active = true
    let timeoutId: ReturnType<typeof setTimeout>

    const poll = async () => {
      try {
        const data = await fetchJobs(projectFilter || undefined, { limit: pageLimit })
        if (!active) return
        const sorted = data.jobs.sort((a, b) => b.started_at - a.started_at)
        setJobs(sorted)
        setLoading(false)
        setLoadingMore(false)
        // If the server returned fewer than we asked for, there's nothing
        // more to load. Otherwise assume more pages might exist.
        setHasMore(sorted.length >= pageLimit)
        // Poll faster while jobs are actively running, back off when idle.
        const hasRunning = sorted.some(j => j.status === 'running')
        timeoutId = setTimeout(poll, hasRunning ? 5000 : 15000)
      } catch {
        if (active) timeoutId = setTimeout(poll, 15000)
      }
    }

    poll()
    return () => { active = false; clearTimeout(timeoutId) }
  }, [projectFilter, pageLimit])

  // IntersectionObserver on a sentinel below the table — triggers
  // `setPageLimit` to bump the request size, which the polling effect
  // picks up and re-fetches.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (loading || !hasMore) return
    const node = sentinelRef.current
    if (!node) return
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setLoadingMore(true)
        setPageLimit((n) => n + PAGE_SIZE)
      }
    }, { rootMargin: '400px' })
    obs.observe(node)
    return () => obs.disconnect()
  }, [loading, hasMore, jobs.length])

  const filtered = jobs.filter((j) => {
    if (filter === 'running' && !jobIsRunning(j)) return false
    if (filter === 'failed' && !jobNeedsAttention(j)) return false
    if (filter === 'done' && !jobSucceeded(j)) return false
    if (search) {
      const q = search.toLowerCase()
      const haystack = [
        j.project,
        j.kind,
        j.user_prompt ?? '',
        j.prompt ?? '',
        j.model ?? '',
        j.provider ?? '',
        j.verdict ?? '',
        j.work_summary ?? '',
      ].join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  const runningCount = jobs.filter(jobIsRunning).length
  const failedCount = jobs.filter(jobNeedsAttention).length
  const doneCount = jobs.length - runningCount - failedCount

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-text-primary">
          Runs
          {projectFilter && (
            <>
              {' — '}{projectFilter}
              <button
                className="text-accent hover:underline text-sm ml-2"
                onClick={() => router.push('/runs')}
              >
                show all
              </button>
            </>
          )}
        </h2>
        <div className="flex items-center gap-3">
          {boardUrl && (
            <a
              href={boardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border bg-bg-secondary text-text-secondary hover:text-accent hover:border-accent/40 transition-colors"
              title="Open the TamTam project board on GitHub"
            >
              Board ↗
            </a>
          )}
          <input
            type="search"
            placeholder="Filter by project, kind, or prompt…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-md border border-border bg-bg-secondary text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors w-64"
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap mb-4">
        {(['all', 'running', 'failed', 'done'] as const).map((f) => {
          const count = f === 'all' ? jobs.length : f === 'running' ? runningCount : f === 'failed' ? failedCount : doneCount
          const active = filter === f
          const tone =
            f === 'running' ? (active ? 'border-status-info bg-status-info/15 text-status-info' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-info') :
            f === 'failed' ? (active ? 'border-status-error bg-status-error/15 text-status-error' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-error') :
            f === 'done' ? (active ? 'border-status-success bg-status-success/15 text-status-success' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-success') :
            (active ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary')
          return (
            <button
              key={f}
              className={`px-2.5 py-1 text-xs rounded-full font-mono cursor-pointer border transition-colors ${tone}`}
              onClick={() => setFilter(f)}
            >
              {f} <span className="opacity-70">{count}</span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="border-t border-border/60 first:border-t-0 border-l-[3px] border-l-border px-4 py-3"
              style={{ opacity: 1 - i * 0.08 }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="skeleton h-5 w-16 rounded-full" />
                    <div className="skeleton h-4 w-24" />
                    <div className="skeleton h-4 w-14 rounded" />
                    <div className="skeleton h-4 w-18 rounded-full" />
                  </div>
                  <div className="mt-2 skeleton h-4 w-full max-w-xl" />
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <div className="skeleton h-3.5 w-20" />
                    <div className="skeleton h-3.5 w-16" />
                    <div className="skeleton h-3.5 w-14" />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="skeleton h-4 w-14 ml-auto" />
                  <div className="mt-1 skeleton h-3.5 w-12 ml-auto" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <p className="text-sm text-text-secondary">
            {search ? `No runs matching "${search}"` : filter === 'all' ? 'No runs yet — trigger an agent or run from a project page' : `No ${filter} runs`}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          {filtered.map((job) => {
            const status = getJobStatus(job)
            const prompt = promptPreview(job)
            const totalTokens = formatTokens(job)
            const tokenPair = formatTokenPair(job)
            const cost = formatCost(job)
            const durationLabel = formatDuration(job.started_at, job.finished_at)
            const startedLabel = formatAgo(job.started_at)
            return (
              <div
                key={job.id}
                className={`border-t border-border/60 first:border-t-0 border-l-[3px] ${status.border} px-4 py-3 hover:bg-bg-tertiary/40 cursor-pointer transition-colors`}
                onClick={() => router.push(job.kind === 'run' && job.session_id ? `/project/${job.project}/terminal/${job.session_id}` : `/project/${job.project}/terminal?job=${encodeURIComponent(job.id)}`)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.badgeClass}`}>
                        <span className={status.isRunning ? 'animate-pulse' : ''}>●</span>
                        {status.badge}
                      </span>
                      <Link
                        href={`/project/${job.project}`}
                        data-private
                        className="text-sm font-medium text-text-primary hover:text-accent transition-colors"
                        onClick={e => e.stopPropagation()}
                      >
                        {job.project}
                      </Link>
                      <KindBadge kind={job.kind} />
                      {job.verdict && !status.isRunning && <VerdictBadge verdict={job.verdict} />}
                    </div>

                    <div
                      className={`mt-1 text-sm ${prompt ? 'text-text-secondary' : 'text-text-tertiary'} truncate`}
                      title={prompt ?? undefined}
                    >
                      {prompt ? `${prompt.slice(0, 140)}${prompt.length > 140 ? '…' : ''}` : '—'}
                    </div>

                    <div className="mt-1.5 flex items-center gap-x-2 gap-y-1 flex-wrap text-[11px] text-text-tertiary font-mono">
                      {job.model && <MetaChip label="model" value={job.model} tone="accent" />}
                      {job.provider && <MetaChip label="provider" value={job.provider} />}
                      {job.session_id && <MetaChip label="session" value={`#${job.session_id.slice(0, 8)}`} />}
                      {job.work_summary && !job.user_prompt && !job.prompt && (
                        <span className="max-w-[28rem] truncate text-text-secondary normal-case font-sans" title={job.work_summary}>
                          {job.work_summary}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div className="font-mono text-sm font-semibold tabular-nums text-text-primary">
                      {durationLabel}
                    </div>
                    <div className="mt-1 flex justify-end">
                      <MetaChip label="started" value={startedLabel} />
                    </div>
                    {(totalTokens || cost || tokenPair) && (
                      <div className="mt-2 flex flex-col items-end gap-1 rounded-md border border-border bg-bg-primary/50 px-2 py-1 font-mono text-[11px] tabular-nums">
                        {tokenPair && (
                          <span className="text-text-tertiary" title="Input / output tokens">
                            <span className="text-status-success">{tokenPair.split(' ')[0]}</span>{' '}
                            <span className="text-accent">{tokenPair.split(' ')[1]}</span>
                          </span>
                        )}
                        <div className="flex items-center gap-2">
                          {totalTokens && <span className="text-text-tertiary">{totalTokens}</span>}
                          {cost && <span className="text-accent/70">{cost}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {/* Infinite-scroll sentinel + status. Hidden until the initial page
          finished loading so the skeleton doesn't fight with this. */}
      {!loading && filtered.length > 0 && (
        <div ref={sentinelRef} className="flex justify-center items-center gap-2 py-6 text-xs text-text-tertiary font-mono">
          {hasMore
            ? loadingMore
              ? <><span className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />Loading more…</>
              : `Showing ${filtered.length} of ${jobs.length}+`
            : (search || filter !== 'all'
                ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`
                : `End of runs · ${jobs.length} total`)}
        </div>
      )}
    </div>
  )
}
