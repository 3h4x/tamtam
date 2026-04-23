'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { fetchJobs } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'
import { formatAgo } from '@/lib/format'

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

function KindBadge({ kind }: { kind: string }) {
  const colors: Record<string, string> = {
    run: 'bg-accent/10 text-accent',
    review: 'bg-purple-500/10 text-purple-400',
    'fix-ci': 'bg-orange-500/10 text-orange-400',
    fix: 'bg-orange-500/10 text-orange-400',
    test: 'bg-blue-500/10 text-blue-400',
  }
  return (
    <span className={`px-1.5 py-0.5 text-xs rounded font-medium ${colors[kind] ?? 'bg-bg-tertiary text-text-tertiary'}`}>
      {kind}
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

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const data = await fetchJobs(projectFilter || undefined)
        if (active) {
          setJobs(data.jobs.sort((a, b) => b.started_at - a.started_at))
          setLoading(false)
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [projectFilter])

  const filtered = jobs.filter((j) => {
    if (filter === 'running' && j.status !== 'running') return false
    if (filter === 'failed' && !(j.status === 'done' && j.exit_code !== 0)) return false
    if (filter === 'done' && !(j.status === 'done' && j.exit_code === 0)) return false
    if (search) {
      const q = search.toLowerCase()
      const prompt = (j.user_prompt ?? j.prompt ?? '').toLowerCase()
      if (!j.project.toLowerCase().includes(q) && !j.kind.toLowerCase().includes(q) && !prompt.includes(q)) return false
    }
    return true
  })

  const runningCount = jobs.filter(j => j.status === 'running').length
  const failedCount = jobs.filter(j => j.status === 'done' && j.exit_code !== 0).length
  const doneCount = jobs.length - runningCount - failedCount

  return (
    <div className="p-6">
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

      <div className="flex gap-1 border-b border-border mb-4">
        {(['all', 'running', 'failed', 'done'] as const).map((f) => (
          <button
            key={f}
            className={`px-3 py-1.5 text-sm cursor-pointer transition-colors ${filter === f ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' && `All (${jobs.length})`}
            {f === 'running' && `Running (${runningCount})`}
            {f === 'failed' && `Failed (${failedCount})`}
            {f === 'done' && `Done (${doneCount})`}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-px">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-4 px-4 py-3 border-t border-border" style={{ opacity: 1 - i * 0.1 }}>
              <div className="skeleton h-5 w-16 rounded-full" />
              <div className="skeleton h-4 w-28" />
              <div className="skeleton h-5 w-14 rounded" />
              <div className="skeleton h-4 w-48" />
              <div className="skeleton h-4 w-20 ml-auto" />
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
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-xs text-text-secondary uppercase tracking-wider">
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Project</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Prompt</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Tokens</th>
              <th className="px-4 py-3">Cost</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((job) => {
              const isRunning = job.status === 'running'
              const isFailed = !isRunning && job.exit_code !== 0
              const promptText = job.user_prompt ?? job.prompt ?? null
              const tokens = formatTokens(job)
              const cost = formatCost(job)
              return (
                <tr
                  key={job.id}
                  className="border-t border-border hover:bg-bg-secondary/50 cursor-pointer"
                  onClick={() => router.push(job.kind === 'run' && job.session_id ? `/project/${job.project}/terminal/${job.session_id}` : `/project/${job.project}/terminal?job=${encodeURIComponent(job.id)}`)}
                >
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${isRunning ? 'bg-status-warning/15 text-status-warning' : isFailed ? 'bg-status-error/15 text-status-error' : 'bg-status-success/15 text-status-success'}`}>
                      {isRunning ? '● running' : isFailed ? '● failed' : '● done'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-text-primary whitespace-nowrap">{job.project}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <KindBadge kind={job.kind} />
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    {promptText ? (
                      <span className="text-sm text-text-secondary truncate block" title={promptText}>
                        {promptText.split('\n')[0].slice(0, 80)}{promptText.length > 80 ? '…' : ''}
                      </span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-sm whitespace-nowrap" title={formatTime(job.started_at)}>
                    {formatAgo(job.started_at)}
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-sm whitespace-nowrap">
                    {formatDuration(job.started_at, job.finished_at)}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary text-xs whitespace-nowrap">
                    {tokens ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary text-xs whitespace-nowrap tabular-nums">
                    {cost ?? '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
