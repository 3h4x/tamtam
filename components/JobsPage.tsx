'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { fetchJobs } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'

// Initial page size and how many additional rows each scroll batch loads.
// Kept generous enough that a single batch covers a typical viewport so
// the user doesn't see a "loading more" flicker after every screen.
const PAGE_SIZE = 50

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

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
    ? 'bg-purple-500/15 text-purple-400'
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
  const label = verdict === 'LGTM' ? '✓ LGTM' : verdict === 'DO NOT SHIP' ? '✗ DNS' : '⚠ ATTN'
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full font-mono font-medium border ${cls}`}
      title={`Review verdict: ${verdict}`}
    >
      {label}
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
    if (filter === 'running' && j.status !== 'running') return false
    if (filter === 'failed' && !(j.status === 'done' && j.exit_code !== null && j.exit_code !== 0)) return false
    if (filter === 'done' && !(j.status === 'done' && (j.exit_code === 0 || j.exit_code === null))) return false
    if (search) {
      const q = search.toLowerCase()
      const prompt = (j.user_prompt ?? j.prompt ?? '').toLowerCase()
      if (!j.project.toLowerCase().includes(q) && !j.kind.toLowerCase().includes(q) && !prompt.includes(q)) return false
    }
    return true
  })

  const runningCount = jobs.filter(j => j.status === 'running').length
  const failedCount = jobs.filter(j => j.status === 'done' && j.exit_code !== null && j.exit_code !== 0).length
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
            f === 'running' ? (active ? 'border-status-warning bg-status-warning/15 text-status-warning' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-warning') :
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
        <div className="space-y-px">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-2 border-t border-border" style={{ opacity: 1 - i * 0.1 }}>
              <div className="skeleton h-5 w-20 rounded-full shrink-0" />
              <div className="skeleton h-4 w-28 shrink-0" />
              <div className="skeleton h-5 w-14 rounded shrink-0" />
              <div className="skeleton h-4 flex-1 max-w-xs" />
              <div className="skeleton h-4 w-16 shrink-0" />
              <div className="skeleton h-4 w-12 shrink-0" />
              <div className="skeleton h-4 w-14 shrink-0" />
              <div className="skeleton h-4 w-12 shrink-0" />
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
        <table className="w-full border-collapse">
          <thead className="bg-bg-tertiary border-b border-border">
            <tr className="text-left text-[11px] text-text-secondary uppercase tracking-wider">
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Project</th>
              <th className="px-4 py-2 font-medium">Kind</th>
              <th className="px-4 py-2 font-medium">Prompt</th>
              <th className="px-4 py-2 font-medium">Started</th>
              <th className="px-4 py-2 font-medium text-right">Duration</th>
              <th className="px-4 py-2 font-medium text-right">Tokens</th>
              <th className="px-4 py-2 font-medium text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((job) => {
              const isRunning = job.status === 'running'
              const isFailed = !isRunning && job.exit_code !== null && job.exit_code !== 0
              const promptText = job.user_prompt ?? job.prompt ?? null
              const tokens = formatTokens(job)
              const cost = formatCost(job)
              return (
                <tr
                  key={job.id}
                  className={`border-t border-border/60 hover:bg-bg-tertiary/40 cursor-pointer transition-colors border-l-2 ${isRunning ? 'border-l-status-warning' : isFailed ? 'border-l-status-error' : 'border-l-transparent'}`}
                  onClick={() => router.push(job.kind === 'run' && job.session_id ? `/project/${job.project}/terminal/${job.session_id}` : `/project/${job.project}/terminal?job=${encodeURIComponent(job.id)}`)}
                >
                  <td className="px-4 py-2 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full font-medium ${isRunning ? 'bg-status-warning/15 text-status-warning' : isFailed ? 'bg-status-error/15 text-status-error' : 'bg-status-success/15 text-status-success'}`}>
                        <span className={isRunning ? 'animate-pulse' : ''}>●</span>
                        {isRunning ? 'running' : isFailed ? `exit ${job.exit_code}` : 'done'}
                      </span>
                      {job.verdict && !isRunning && <VerdictBadge verdict={job.verdict} />}
                    </div>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <Link
                      href={`/project/${job.project}`}
                      className="font-medium text-text-primary hover:text-accent transition-colors"
                      onClick={e => e.stopPropagation()}
                    >
                      {job.project}
                    </Link>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <KindBadge kind={job.kind} />
                  </td>
                  <td className="px-4 py-2 max-w-xs">
                    {promptText ? (
                      <span className="text-sm text-text-secondary truncate block" title={promptText}>
                        {promptText.split('\n')[0].slice(0, 80)}{promptText.length > 80 ? '…' : ''}
                      </span>
                    ) : KIND_HINTS[job.kind] ? (
                      <span className="text-xs text-text-tertiary italic">{KIND_HINTS[job.kind]}</span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-text-secondary text-sm whitespace-nowrap" title={formatTime(job.started_at)}>
                    {formatAgo(job.started_at)}
                  </td>
                  <td className="px-4 py-2 text-right text-text-secondary text-sm whitespace-nowrap tabular-nums">
                    {formatDuration(job.started_at, job.finished_at)}
                  </td>
                  <td className="px-4 py-2 text-right text-text-tertiary text-xs whitespace-nowrap tabular-nums">
                    {tokens ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right text-text-tertiary text-xs whitespace-nowrap tabular-nums">
                    {cost ?? '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}
      {/* Infinite-scroll sentinel + status. Hidden until the initial page
          finished loading so the skeleton doesn't fight with this. */}
      {!loading && filtered.length > 0 && (
        <div ref={sentinelRef} className="flex justify-center py-6 text-xs text-text-tertiary font-mono">
          {hasMore
            ? (loadingMore ? 'Loading more…' : `Showing ${filtered.length} of ${jobs.length}+`)
            : (search || filter !== 'all'
                ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`
                : `End of runs · ${jobs.length} total`)}
        </div>
      )}
    </div>
  )
}
