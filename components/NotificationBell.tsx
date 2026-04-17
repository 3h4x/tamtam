'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { fetchNotifications, markNotificationsSeen, markJobSeen, fetchJobs } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor(Date.now() / 1000 - startedAt)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function NotificationBell() {
  const router = useRouter()
  const [count, setCount] = useState(0)
  const [finishedJobs, setFinishedJobs] = useState<JobInfo[]>([])
  const [runningJobs, setRunningJobs] = useState<JobInfo[]>([])
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const poll = async () => {
      try {
        const [notifs, allJobs] = await Promise.all([
          fetchNotifications(),
          fetchJobs(),
        ])
        setCount(notifs.count)
        const sorted = [...notifs.jobs].sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))
        const seen = new Set<string>()
        const deduped = sorted.filter(j => {
          const key = `${j.project}:${j.kind}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        setFinishedJobs(deduped)
        setRunningJobs(allJobs.jobs.filter(j => j.status === 'running'))
      } catch {
        // ignore
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleBellClick = () => {
    setOpen(!open)
  }

  const handleJobClick = (job: JobInfo) => {
    setOpen(false)
    if (job.status === 'done') {
      markJobSeen(job.id).catch(() => {})
    }
    if (job.kind === 'run' && job.session_id) {
      router.push(`/project/${job.project}/terminal/${job.session_id}`)
    } else {
      router.push(`/project/${job.project}/terminal?job=${encodeURIComponent(job.id)}`)
    }
  }

  const handleDismiss = async () => {
    await markNotificationsSeen()
    setCount(0)
    setFinishedJobs([])
    setOpen(false)
  }

  const totalBadge = count + runningJobs.length
  const hasItems = runningJobs.length > 0 || finishedJobs.length > 0

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        className={`relative p-2 bg-transparent border border-border rounded-md cursor-pointer text-text-secondary hover:text-text-primary hover:border-text-tertiary transition-colors ${runningJobs.length > 0 ? 'text-accent border-accent' : ''}`}
        onClick={handleBellClick}
        title={totalBadge > 0 ? `${runningJobs.length} running, ${count} finished` : 'No notifications'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1.5a4 4 0 0 0-4 4v2.5L2.5 10.5h11L12 8V5.5a4 4 0 0 0-4-4Z" />
          <path d="M6.5 12a1.5 1.5 0 0 0 3 0" />
        </svg>
        {totalBadge > 0 && (
          <span className={`absolute -top-1 -right-1 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-medium ${runningJobs.length > 0 ? 'bg-accent animate-pulse' : 'bg-status-error'}`}>
            {totalBadge}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-bg-primary border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-sm font-semibold text-text-primary">Notifications</span>
            {finishedJobs.length > 0 && (
              <button
                className="text-xs text-accent hover:text-accent-hover bg-transparent border-none cursor-pointer"
                onClick={handleDismiss}
              >
                Clear all
              </button>
            )}
          </div>
          {!hasItems ? (
            <div className="px-4 py-6 text-center text-sm text-text-tertiary">No notifications</div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {runningJobs.map((job) => (
                <button
                  key={job.id}
                  className="w-full flex items-center gap-3 px-4 py-3 border-b border-border hover:bg-bg-secondary transition-colors bg-transparent cursor-pointer text-left"
                  onClick={() => handleJobClick(job)}
                >
                  <span className="text-accent">
                    <span className="spinner-sm" />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{job.kind}</span>
                      <span className="text-xs text-text-tertiary">{job.project}</span>
                    </div>
                    <div className="text-xs text-text-tertiary">
                      <span>{formatElapsed(job.started_at)}</span>
                    </div>
                  </div>
                </button>
              ))}
              {finishedJobs.map((job) => {
                const elapsed = job.finished_at && job.started_at
                  ? Math.floor(job.finished_at - job.started_at)
                  : null
                const elapsedStr = elapsed !== null
                  ? elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                  : null
                const finishedAt = job.finished_at
                  ? new Date(job.finished_at * 1000)
                  : null
                const timeAgo = finishedAt ? formatTimeAgo(finishedAt) : null
                const isSuccess = job.exit_code === 0
                const verdict = job.verdict
                const verdictIcon = verdict === 'LGTM' ? '\u2705' : verdict === 'NEEDS ATTENTION' ? '\u26A0\uFE0F' : verdict === 'DO NOT SHIP' ? '\u274C' : null
                const verdictClass = verdict === 'LGTM' ? 'text-status-success' : verdict === 'NEEDS ATTENTION' ? 'text-status-warning' : verdict === 'DO NOT SHIP' ? 'text-status-error' : ''

                return (
                  <button
                    key={job.id}
                    className={`w-full flex items-center gap-3 px-4 py-3 border-b border-border hover:bg-bg-secondary transition-colors bg-transparent cursor-pointer text-left ${isSuccess ? 'border-l-2 border-l-status-success' : 'border-l-2 border-l-status-error'}`}
                    onClick={() => handleJobClick(job)}
                  >
                    <span className={`text-sm font-bold shrink-0 ${isSuccess ? 'text-status-success' : 'text-status-error'}`}>
                      {isSuccess ? '\u2713' : '\u2717'}
                    </span>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary">{job.kind}</span>
                        <span className="text-xs text-text-tertiary">{job.project}</span>
                        {verdict && (
                          <span className={`text-xs font-medium ${verdictClass}`}>
                            {verdictIcon} {verdict}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-text-tertiary">
                        {elapsedStr && <span>{elapsedStr}</span>}
                        {!isSuccess && !verdict && <span className="text-status-error">exit {job.exit_code}</span>}
                        {timeAgo && <span>{timeAgo}</span>}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
