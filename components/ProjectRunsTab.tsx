'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { fetchJobs } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'

function formatDuration(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt || Date.now() / 1000
  const s = Math.max(0, Math.floor(end - startedAt))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function formatAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
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
    if (bucket === 'run' && j.session_id) {
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
      key: bucket === 'run' && j.session_id ? `sess:${j.session_id}` : `job:${j.id}`,
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
      turns: bucket === 'run' ? 1 : 0,
      model: modelFromContext(j.context_meta),
      navJobId: j.id,
      navSessionId: j.session_id ?? null,
      verdict: j.verdict,
    }
    if (bucket === 'run' && j.session_id) sessionGroup.set(j.session_id, entry)
    entries.push(entry)
  }

  entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return entries
}

interface ProjectRunsTabProps {
  projectName: string
}

type StatusFilter = 'all' | 'running' | 'failed' | 'done'

export function ProjectRunsTab({ projectName }: ProjectRunsTabProps) {
  const router = useRouter()
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [kindFilter, setKindFilter] = useState<KindBucket | 'all'>('all')

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

  const kindCounts = useMemo(() => {
    const c: Record<KindBucket | 'all', number> = {
      all: entries.length, run: 0, review: 0, test: 0, 'fix-ci': 0, agent: 0, other: 0,
    }
    for (const e of entries) c[e.bucket] += 1
    return c
  }, [entries])

  const statusCounts = useMemo(() => {
    let running = 0, failed = 0, done = 0
    for (const e of entries) {
      if (e.status === 'running') running += 1
      else if (e.exitCode !== 0) failed += 1
      else done += 1
    }
    return { all: entries.length, running, failed, done }
  }, [entries])

  const filtered = entries.filter((e) => {
    if (kindFilter !== 'all' && e.bucket !== kindFilter) return false
    if (statusFilter === 'running' && e.status !== 'running') return false
    if (statusFilter === 'failed' && !(e.status === 'done' && e.exitCode !== 0)) return false
    if (statusFilter === 'done' && !(e.status === 'done' && e.exitCode === 0)) return false
    return true
  })

  const navigate = (e: Entry) => {
    if (e.bucket === 'run' && e.navSessionId) {
      router.push(`/project/${projectName}/terminal/${e.navSessionId}`)
    } else {
      router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(e.navJobId)}`)
    }
  }

  return (
    <div className="mt-4">
      {/* Filters */}
      <div className="flex flex-col gap-2 mb-3">
        <div className="flex gap-1 border-b border-border">
          {(['all', 'running', 'failed', 'done'] as const).map((f) => {
            const count = statusCounts[f]
            return (
              <button
                key={f}
                className={`px-3 py-1.5 text-sm cursor-pointer ${statusFilter === f ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
                onClick={() => setStatusFilter(f)}
              >
                {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)} ({count})
              </button>
            )
          })}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(['all', 'run', 'review', 'test', 'fix-ci', 'agent', 'other'] as const).map((k) => {
            const count = kindCounts[k as keyof typeof kindCounts]
            if (k !== 'all' && count === 0) return null
            const label = k === 'all' ? 'all kinds' : KIND_LABEL[k as KindBucket]
            return (
              <button
                key={k}
                className={`px-2 py-0.5 text-xs rounded-full font-mono cursor-pointer border ${
                  kindFilter === k
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
                }`}
                onClick={() => setKindFilter(k as KindBucket | 'all')}
              >
                {label} <span className="text-text-tertiary">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="text-text-secondary text-sm">Loading runs...</div>
      ) : filtered.length === 0 ? (
        <div className="text-text-secondary text-sm p-6 text-center">
          {entries.length === 0 ? 'No runs yet' : 'No runs match the current filters'}
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden bg-bg-secondary">
          {filtered.map((e) => {
            const isRunning = e.status === 'running'
            const isFailed = !isRunning && e.exitCode !== 0
            const totalTokens = e.inputTokens + e.outputTokens
            return (
              <button
                key={e.key}
                className="w-full text-left border-b border-border last:border-b-0 hover:bg-bg-tertiary cursor-pointer px-4 py-3 flex items-start gap-3 group"
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
      )}
    </div>
  )
}
