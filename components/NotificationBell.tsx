'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { fetchNotifications, markNotificationsSeen, markJobSeen } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'
import { jobIsFinished } from '@/lib/client/job-status'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pill } from '@/components/ui/Pill'
import { Spinner } from '@/components/ui/Spinner'
import { StatusIcon } from '@/components/ui/StatusIcon'

// Sky view: one running entry per project (highest-priority kind wins)
const KIND_PRIORITY: Record<string, number> = {
  release: 100, 'mark-dod': 90, 'pr-wait': 85,
  fix: 80, review: 75, test: 70, push: 65, commit: 60,
  run: 40, action: 35,
}
const kindPriority = (k: string): number =>
  k.startsWith('agent:') ? 50 : (KIND_PRIORITY[k] ?? 30)

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function elapsed(startedAt: number, finishedAt?: number | null): string {
  const s = Math.floor((finishedAt ?? (Date.now() / 1000)) - startedAt)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function KindBadge({ kind }: { kind: string }) {
  const labels: Record<string, string> = {
    run: 'run',
    review: 'review',
    'fix-ci': 'fix ci',
    fix: 'fix',
    test: 'test',
  }
  return (
    <Pill size="xs" className="rounded border-transparent bg-bg-tertiary px-1.5 text-text-tertiary">
      {labels[kind] ?? kind}
    </Pill>
  )
}

function VerdictBadge({ verdict }: { verdict: string }) {
  if (verdict === 'LGTM') {
    return <span className="text-xs font-medium text-status-success">LGTM</span>
  }
  if (verdict === 'NEEDS ATTENTION') {
    return <span className="text-xs font-medium text-status-warning">needs attention</span>
  }
  if (verdict === 'DO NOT SHIP') {
    return <span className="text-xs font-medium text-status-error">do not ship</span>
  }
  return null
}

function finishedJobState(job: JobInfo): { success: boolean; detailLabel: string | null } {
  if (job.kind === 'review' && job.status === 'done') {
    if (job.verdict === 'LGTM') return { success: true, detailLabel: null }
    if (job.verdict === 'NEEDS ATTENTION' || job.verdict === 'DO NOT SHIP') {
      return { success: false, detailLabel: null }
    }
    return { success: false, detailLabel: 'review verdict missing' }
  }

  const success = job.exit_code === 0 || job.exit_code === null
  return { success, detailLabel: success ? null : `exit ${job.exit_code}` }
}

function collapseFinishedJobs(jobs: JobInfo[]): JobInfo[] {
  const byProject = new Map<string, JobInfo[]>()
  for (const job of jobs) {
    const list = byProject.get(job.project) ?? []
    list.push(job)
    byProject.set(job.project, list)
  }

  const picked: JobInfo[] = []
  for (const projectJobs of byProject.values()) {
    const sorted = [...projectJobs].sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))
    const attentionJob = sorted.find((job) => !finishedJobState(job).success)
    picked.push(attentionJob ?? sorted[0])
  }

  return picked.sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))
}

function RunningIcon() {
  return <Spinner size="xl" color="accent" shrink />
}

export function NotificationBell() {
  const router = useRouter()
  const [unseenCount, setUnseenCount] = useState(0)
  const [finishedJobs, setFinishedJobs] = useState<JobInfo[]>([])
  const [runningJobs, setRunningJobs] = useState<JobInfo[]>([])
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const poll = async () => {
      try {
        const notifs = await fetchNotifications()
        setUnseenCount(notifs.count)

        // Sky view: one running entry per project (highest-priority kind wins).
        // KIND_PRIORITY + kindPriority hoisted to module level — they don't
        // change between polls.
        const runningByProject = new Map<string, JobInfo>()
        for (const j of (notifs.runningJobs ?? [])) {
          const existing = runningByProject.get(j.project)
          if (!existing || kindPriority(j.kind) > kindPriority(existing.kind)) {
            runningByProject.set(j.project, j)
          }
        }
        setRunningJobs([...runningByProject.values()])

        // Sky view: one finished entry per project. Prefer the newest
        // actionable attention item over a newer green remediation step so an
        // unsuperseded failure stays visible until a terminal success clears it.
        setFinishedJobs(collapseFinishedJobs(notifs.jobs))
      } catch {
        // ignore
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleJobClick = (job: JobInfo) => {
    setOpen(false)
    if (jobIsFinished(job)) markJobSeen(job.id).catch(() => {})
    if (job.kind === 'run' && job.session_id) {
      router.push(`/project/${encodeURIComponent(job.project)}/terminal/${encodeURIComponent(job.session_id)}`)
    } else {
      router.push(`/project/${encodeURIComponent(job.project)}/terminal?job=${encodeURIComponent(job.id)}`)
    }
  }

  const handleClearAll = async () => {
    await markNotificationsSeen()
    setUnseenCount(0)
    setFinishedJobs([])
  }

  const hasItems = runningJobs.length > 0 || finishedJobs.length > 0
  const isRunning = runningJobs.length > 0

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button */}
      <Button
        onClick={() => setOpen(v => !v)}
        title={[
          isRunning ? `${runningJobs.length} running` : '',
          unseenCount > 0 ? `${unseenCount} unread` : '',
        ].filter(Boolean).join(', ') || 'No notifications'}
        className={`relative !p-2 bg-transparent border rounded-md cursor-pointer transition-colors ${
          open
            ? 'border-accent text-accent'
            : 'border-border text-text-secondary hover:text-text-primary hover:border-text-tertiary'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1.5a4 4 0 0 0-4 4v2.5L2.5 10.5h11L12 8V5.5a4 4 0 0 0-4-4Z" />
          <path d="M6.5 12a1.5 1.5 0 0 0 3 0" />
        </svg>

        {/* Unread badge — count what the dropdown actually surfaces (one per
            project, after the sky-view collapse) so the number on the bell
            matches what the user sees when they open it. The raw `unseenCount`
            counts every individual unseen job and was confusing when one
            chatty project produced dozens of pipeline children. */}
        {finishedJobs.length > 0 && (
          <span
            className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 bg-status-error text-white text-[10px] font-semibold rounded-full flex items-center justify-center leading-none"
            title={unseenCount > finishedJobs.length ? `${finishedJobs.length} project${finishedJobs.length === 1 ? '' : 's'} need attention (${unseenCount} unseen items in total)` : undefined}
          >
            {finishedJobs.length > 99 ? '99+' : finishedJobs.length}
          </span>
        )}

        {/* Running indicator dot (only when no unread badge) */}
        {isRunning && finishedJobs.length === 0 && (
          <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-accent rounded-full animate-pulse" />
        )}
      </Button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[22rem] bg-bg-primary border border-border rounded-lg shadow-lg z-50 overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <span className="text-sm font-semibold text-text-primary">Notifications</span>
            {finishedJobs.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearAll}
                className="!px-0 !py-0 text-xs font-normal text-text-tertiary hover:text-text-primary hover:bg-transparent bg-transparent border-none"
              >
                Clear all
              </Button>
            )}
          </div>

          {!hasItems ? (
            <EmptyState
              paddingY="sm"
              icon={
                <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              }
              title="All caught up"
            />
          ) : (
            <div className="max-h-[420px] overflow-y-auto">

              {/* Running section */}
              {runningJobs.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 bg-bg-secondary border-b border-border">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                      Running · {runningJobs.length} {runningJobs.length === 1 ? 'project' : 'projects'}
                    </span>
                  </div>
                  {runningJobs.map(job => {
                    // When a running release was triggered by an agent, render
                    // the agent's kind on the badge so the bell shows the
                    // workflow's identity rather than the "release" wrapper.
                    // Same merge story as the Overview tab's active-work tile.
                    const displayKind = job.kind === 'release' && job.parent_kind
                      ? job.parent_kind
                      : job.kind
                    return (
                    <button
                      key={job.id}
                      onClick={() => handleJobClick(job)}
                      className="w-full flex items-center gap-3 px-4 py-2 border-b border-border/50 hover:bg-bg-secondary transition-colors bg-transparent cursor-pointer text-left"
                    >
                      <RunningIcon />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary truncate">{job.project}</span>
                          <KindBadge kind={displayKind} />
                        </div>
                        <p className="text-xs text-text-tertiary mt-0.5">
                          {elapsed(job.started_at)}
                          {displayKind !== job.kind && <span className="ml-1.5 text-text-tertiary/70">· release in progress</span>}
                        </p>
                      </div>
                    </button>
                    )
                  })}
                </div>
              )}

              {/* Finished section */}
              {finishedJobs.length > 0 && (
                <div>
                  {runningJobs.length > 0 && (
                    <div className="px-4 py-1.5 bg-bg-secondary border-b border-border">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                        Recent
                      </span>
                    </div>
                  )}
                  {finishedJobs.map(job => {
                    const state = finishedJobState(job)
                    const dur = elapsed(job.started_at, job.finished_at)
                    const ago = job.finished_at ? timeAgo(new Date(job.finished_at * 1000)) : null

                    return (
                      <button
                        key={job.id}
                        onClick={() => handleJobClick(job)}
                        className="w-full flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-bg-secondary transition-colors bg-transparent cursor-pointer text-left"
                      >
                        <StatusIcon ok={state.success} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-text-primary truncate">{job.project}</span>
                            <KindBadge kind={job.kind} />
                            {job.verdict && <VerdictBadge verdict={job.verdict} />}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-text-tertiary">{dur}</span>
                            {ago && <span className="text-xs text-text-tertiary">· {ago}</span>}
                            {!state.success && state.detailLabel && (
                              <span className="text-xs text-status-error">{state.detailLabel}</span>
                            )}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="px-4 py-2.5 border-t border-border">
            <Link
              href="/workflow-runs"
              onClick={() => setOpen(false)}
              className="text-xs text-text-tertiary hover:text-text-primary transition-colors no-underline flex items-center gap-1"
            >
              View all runs
              <svg className="w-3 h-3" fill="none" viewBox="0 0 6 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 1l4 4-4 4" />
              </svg>
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
