'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { fetchJobs } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'
import { formatAgo } from '@/lib/format'

function formatDuration(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt || Date.now() / 1000
  const s = Math.max(0, Math.floor(end - startedAt))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}


function dayKey(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(ts: number): string {
  const now = new Date()
  const d = new Date(ts * 1000)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}M`
}

// Bucket kinds for filtering + labeling. Anything that doesn't match lands in
// "other" (covers custom actions, future kinds).
type KindBucket = 'run' | 'review' | 'test' | 'fix-ci' | 'agent' | 'other'

function bucketOf(kind: string): KindBucket {
  if (kind === 'run') return 'run'
  if (kind === 'review') return 'review'
  if (kind === 'test') return 'test'
  if (kind === 'fix-ci') return 'fix-ci'
  if (kind.startsWith('agent:')) return 'agent'
  return 'other'
}

const KIND_LABEL: Record<KindBucket, string> = {
  run: 'chat',
  review: 'review',
  test: 'test',
  'fix-ci': 'fix-ci',
  agent: 'agent',
  other: 'action',
}

const KIND_COLOR: Record<KindBucket, string> = {
  run: 'bg-accent/15 text-accent',
  review: 'bg-status-info/15 text-status-info',
  test: 'bg-status-success/15 text-status-success',
  'fix-ci': 'bg-status-warning/15 text-status-warning',
  agent: 'bg-purple-500/15 text-purple-400',
  other: 'bg-text-tertiary/15 text-text-secondary',
}

// An entry represents a single row in the history. For `run` jobs with a
// session_id we collapse every turn of the conversation into one entry so the
// list reads as "conversations" rather than dozens of identical chat rows.
interface Entry {
  key: string
  kind: string
  bucket: KindBucket
  title: string
  subtitle: string | null
  startedAt: number
  lastActivityAt: number
  finishedAt: number | null
  status: 'running' | 'done'
  exitCode: number | null
  durationMs: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  turns: number
  model: string | null
  navJobId: string
  navSessionId: string | null
  verdict?: JobInfo['verdict']
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function titleForJob(job: JobInfo, bucket: KindBucket): string {
  const prompt = job.user_prompt || job.prompt
  if (bucket === 'run') return prompt ? truncate(prompt, 140) : '(empty prompt)'
  if (bucket === 'review') return 'Code review'
  if (bucket === 'test') return 'Test run'
  if (bucket === 'fix-ci') return 'Fix CI'
  if (bucket === 'agent') return job.kind.replace(/^agent:/, '') || 'agent'
  return job.kind
}

function subtitleForJob(job: JobInfo, bucket: KindBucket): string | null {
  if (bucket === 'review' && job.verdict) return `verdict: ${job.verdict}`
  if ((bucket === 'review' || bucket === 'test' || bucket === 'fix-ci') && job.prompt) {
    return truncate(job.prompt, 140)
  }
  return null
}

function modelFromContext(ctx: string | null | undefined): string | null {
  if (!ctx) return null
  try {
    const m = JSON.parse(ctx)
    return typeof m.model === 'string' ? m.model : null
  } catch { return null }
}

function buildEntries(jobs: JobInfo[]): Entry[] {
  // Sort ascending first so session groupings see the earliest prompt first.
  const sorted = [...jobs].sort((a, b) => a.started_at - b.started_at)
  const sessionGroup = new Map<string, Entry>()
  const entries: Entry[] = []

  for (const j of sorted) {
    const bucket = bucketOf(j.kind)
    if (j.session_id) {
      const existing = sessionGroup.get(j.session_id)
      if (existing) {
        existing.turns += 1
        existing.lastActivityAt = j.started_at
        existing.finishedAt = j.finished_at
        existing.status = j.status
        existing.exitCode = j.exit_code
        existing.durationMs = (existing.durationMs ?? 0) + (j.duration_ms ?? 0)
        existing.inputTokens += j.input_tokens ?? 0
        existing.outputTokens += j.output_tokens ?? 0
        existing.cacheReadTokens += j.cache_read_tokens ?? 0
        existing.navJobId = j.id
        continue
      }
    }

    const entry: Entry = {
      key: j.session_id ? `sess:${j.session_id}` : `job:${j.id}`,
      kind: j.kind,
      bucket,
      title: titleForJob(j, bucket),
      subtitle: subtitleForJob(j, bucket),
      startedAt: j.started_at,
      lastActivityAt: j.started_at,
      finishedAt: j.finished_at,
      status: j.status,
      exitCode: j.exit_code,
      durationMs: j.duration_ms ?? null,
      inputTokens: j.input_tokens ?? 0,
      outputTokens: j.output_tokens ?? 0,
      cacheReadTokens: j.cache_read_tokens ?? 0,
      turns: 1,
      model: modelFromContext(j.context_meta),
      navJobId: j.id,
      navSessionId: j.session_id ?? null,
      verdict: j.verdict,
    }
    if (j.session_id) sessionGroup.set(j.session_id, entry)
    entries.push(entry)
  }

  entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return entries
}

interface ProjectRunsTabProps {
  projectName: string
}

// One-axis filter: either a kind bucket, or a status shortcut.
type Filter =
  | { kind: 'all' }
  | { kind: 'running' }
  | { kind: 'failed' }
  | { kind: 'bucket'; bucket: KindBucket }

function filterKey(f: Filter): string {
  return f.kind === 'bucket' ? `b:${f.bucket}` : f.kind
}

export function ProjectRunsTab({ projectName }: ProjectRunsTabProps) {
  const router = useRouter()
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [search, setSearch] = useState('')

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const data = await fetchJobs(projectName)
        if (active) {
          setJobs(data.jobs)
          setLoading(false)
        }
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [projectName])

  const entries = useMemo(() => buildEntries(jobs), [jobs])

  const counts = useMemo(() => {
    const c = {
      all: entries.length, running: 0, failed: 0,
      run: 0, review: 0, test: 0, 'fix-ci': 0, agent: 0, other: 0,
    } as Record<string, number>
    for (const e of entries) {
      c[e.bucket] += 1
      if (e.status === 'running') c.running += 1
      else if (e.exitCode !== 0) c.failed += 1
    }
    return c
  }, [entries])

  const matches = (e: Entry, f: Filter): boolean => {
    if (f.kind === 'all') return true
    if (f.kind === 'running') return e.status === 'running'
    if (f.kind === 'failed') return e.status === 'done' && e.exitCode !== 0
    return e.bucket === f.bucket
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (!matches(e, filter)) return false
      if (!q) return true
      const hay = `${e.title} ${e.subtitle ?? ''} ${e.model ?? ''} ${e.navSessionId ?? ''} ${e.kind}`.toLowerCase()
      return hay.includes(q)
    })
  }, [entries, filter, search])

  // Group filtered entries by day for scannability.
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; items: Entry[]; ts: number }>()
    for (const e of filtered) {
      const k = dayKey(e.lastActivityAt)
      const g = m.get(k)
      if (g) g.items.push(e)
      else m.set(k, { label: dayLabel(e.lastActivityAt), items: [e], ts: e.lastActivityAt })
    }
    return Array.from(m.values()).sort((a, b) => b.ts - a.ts)
  }, [filtered])

  const totals = useMemo(() => {
    let tokens = 0, running = 0, durationMs = 0
    for (const e of filtered) {
      tokens += e.inputTokens + e.outputTokens
      durationMs += e.durationMs ?? 0
      if (e.status === 'running') running += 1
    }
    return { tokens, running, durationMs }
  }, [filtered])

  const navigate = (e: Entry) => {
    if (e.bucket === 'run' && e.navSessionId) {
      router.push(`/project/${projectName}/terminal/${e.navSessionId}`)
    } else {
      router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(e.navJobId)}`)
    }
  }

  return (
    <div className="mt-4">
      {/* Search + summary */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search prompts, models, session ids…"
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-bg-secondary border border-border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary text-xs" aria-hidden>⌕</span>
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary text-sm cursor-pointer"
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <div className="text-xs text-text-tertiary font-mono whitespace-nowrap">
          {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
          {totals.running > 0 && (
            <> · <span className="text-status-warning">{totals.running} running</span></>
          )}
          {totals.tokens > 0 && <> · {formatTokens(totals.tokens)} tokens</>}
        </div>
      </div>

      {/* Unified filter row: status shortcuts + kind breakdown, one axis. */}
      <div className="flex items-center gap-1.5 flex-wrap mb-3">
        {([
          { f: { kind: 'all' } as Filter, label: 'all', tone: 'neutral' },
          { f: { kind: 'running' } as Filter, label: 'running', tone: 'warning' },
          { f: { kind: 'failed' } as Filter, label: 'failed', tone: 'error' },
        ] as const).map(({ f, label, tone }) => {
          const count = counts[f.kind] ?? 0
          if ((f.kind === 'running' || f.kind === 'failed') && count === 0 && filterKey(filter) !== filterKey(f)) return null
          const active = filterKey(filter) === filterKey(f)
          const toneCls =
            tone === 'warning' ? (active ? 'border-status-warning bg-status-warning/15 text-status-warning' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-warning') :
            tone === 'error' ? (active ? 'border-status-error bg-status-error/15 text-status-error' : 'border-border bg-bg-secondary text-text-secondary hover:text-status-error') :
            (active ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary')
          return (
            <button
              key={label}
              className={`px-2.5 py-1 text-xs rounded-full font-mono cursor-pointer border ${toneCls}`}
              onClick={() => setFilter(f)}
            >
              {label} <span className="opacity-70">{count}</span>
            </button>
          )
        })}
        <span className="h-5 w-px bg-border mx-1" aria-hidden />
        {(['run', 'review', 'test', 'fix-ci', 'agent', 'other'] as const).map((b) => {
          const count = counts[b] ?? 0
          const active = filter.kind === 'bucket' && filter.bucket === b
          if (count === 0 && !active) return null
          return (
            <button
              key={b}
              className={`px-2.5 py-1 text-xs rounded-full font-mono cursor-pointer border ${
                active
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
              }`}
              onClick={() => setFilter({ kind: 'bucket', bucket: b })}
            >
              {KIND_LABEL[b]} <span className="opacity-70">{count}</span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="text-text-secondary text-sm">Loading runs...</div>
      ) : filtered.length === 0 ? (
        <div className="text-text-secondary text-sm p-6 text-center border border-border rounded-lg bg-bg-secondary">
          {entries.length === 0
            ? 'No runs yet'
            : search.trim()
            ? `No runs match "${search.trim()}"`
            : 'No runs match the current filter'}
          {(search.trim() || filter.kind !== 'all') && (
            <div className="mt-3">
              <button
                className="px-3 py-1 text-xs border border-border rounded-md hover:bg-bg-tertiary cursor-pointer"
                onClick={() => { setSearch(''); setFilter({ kind: 'all' }) }}
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="flex items-center gap-2 mb-1.5 px-1">
                <span className="text-[11px] uppercase tracking-wider text-text-tertiary font-semibold">{g.label}</span>
                <span className="text-[11px] text-text-tertiary font-mono">· {g.items.length}</span>
                <div className="flex-1 h-px bg-border/60" />
              </div>
              <div className="border border-border rounded-lg overflow-hidden bg-bg-secondary">
                {g.items.map((e) => {
                  const isRunning = e.status === 'running'
                  const isFailed = !isRunning && e.exitCode !== 0
                  const totalTokens = e.inputTokens + e.outputTokens
                  const accentBorder = isRunning
                    ? 'border-l-2 border-l-status-warning'
                    : isFailed
                    ? 'border-l-2 border-l-status-error'
                    : 'border-l-2 border-l-transparent'
                  return (
                    <button
                      key={e.key}
                      className={`w-full text-left border-b border-border last:border-b-0 hover:bg-bg-tertiary cursor-pointer px-4 py-3 flex items-start gap-3 group ${accentBorder}`}
                      onClick={() => navigate(e)}
                    >
                {/* Kind badge */}
                <span className={`shrink-0 mt-0.5 inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded ${KIND_COLOR[e.bucket]}`}>
                  {KIND_LABEL[e.bucket]}
                </span>

                {/* Primary + secondary */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-primary font-medium truncate group-hover:text-accent">
                    {e.title}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-text-tertiary mt-0.5 flex-wrap">
                    {e.turns > 1 && (
                      <span className="font-mono">{e.turns} turns</span>
                    )}
                    {e.model && <span className="font-mono">{e.model}</span>}
                    {e.navSessionId && (
                      <span className="font-mono">#{e.navSessionId.slice(0, 8)}</span>
                    )}
                    {e.subtitle && <span className="italic truncate">{e.subtitle}</span>}
                  </div>
                </div>

                {/* Stats */}
                <div className="shrink-0 flex flex-col items-end gap-0.5 text-xs">
                  <div className="flex items-center gap-2">
                    {totalTokens > 0 && (
                      <span className="font-mono text-text-tertiary" title="Input / output tokens">
                        <span className="text-status-success">↑{formatTokens(e.inputTokens)}</span>
                        {' '}
                        <span className="text-accent">↓{formatTokens(e.outputTokens)}</span>
                      </span>
                    )}
                    <span className="font-mono text-text-secondary">
                      {formatDuration(e.startedAt, e.finishedAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-text-tertiary text-[11px]">{formatAgo(e.lastActivityAt)}</span>
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
                      isRunning ? 'bg-status-warning/15 text-status-warning' :
                      isFailed ? 'bg-status-error/15 text-status-error' :
                      'bg-status-success/15 text-status-success'
                    }`}>
                      <span className={isRunning ? 'animate-pulse' : ''}>●</span>
                      {isRunning ? 'running' : isFailed ? `exit ${e.exitCode}` : 'done'}
                    </span>
                  </div>
                </div>
              </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
