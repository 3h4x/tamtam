'use client'

import { useCallback, useEffect, useState } from 'react'
import { errMsg } from '@/lib/shared/types'
import { fmtAbsolute } from '@/lib/shared/format-date'

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

interface QuotaWindow { utilization: number; resetsAt: string | null; msUntilReset: number | null }
interface QuotaSnapshot { fiveHour: QuotaWindow; sevenDay: QuotaWindow; gateEnabled?: boolean }

export function JobsPauseToggle() {
  const [jobsPaused, setJobsPaused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [autoThrottle, setAutoThrottle] = useState<{ projectedPct: number; resumesAtMs: number } | null>(null)

  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const res = await fetch('/api/settings')
        const data = await res.json()
        if (!live) return
        setJobsPaused(data.settings?.jobs_paused === 'true')
      } catch {
        if (live) setJobsPaused(false)
      } finally {
        if (live) setLoading(false)
      }
    }
    void load()
    return () => { live = false }
  }, [])

  useEffect(() => {
    let live = true
    const loadQuota = async () => {
      try {
        const res = await fetch('/api/usage/quota')
        if (!res.ok) return
        const snap = (await res.json()) as QuotaSnapshot
        if (!live) return
        // Only flag throttle when the server-side gate is enabled — otherwise
        // the indicator would lie about scheduled agents being paused.
        if (!snap.gateEnabled) { setAutoThrottle(null); return }
        const win = snap.sevenDay
        if (win.msUntilReset == null || win.msUntilReset <= 0) {
          setAutoThrottle(null)
          return
        }
        const elapsed = SEVEN_DAY_MS - win.msUntilReset
        if (elapsed <= 0) { setAutoThrottle(null); return }
        const projectedPct = win.utilization * (SEVEN_DAY_MS / elapsed)
        if (projectedPct <= 100) { setAutoThrottle(null); return }
        const requiredElapsed = win.utilization * SEVEN_DAY_MS / 100
        const resumesAtMs = Date.now() + Math.max(0, requiredElapsed - elapsed)
        setAutoThrottle({ projectedPct, resumesAtMs })
      } catch {
        // ignore — fail open
      }
    }
    void loadQuota()
    const id = setInterval(loadQuota, 60_000)
    return () => { live = false; clearInterval(id) }
  }, [])

  const toggle = useCallback(async () => {
    if (saving) return
    const next = !jobsPaused
    setSaving(true)
    setJobsPaused(next)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs_paused: next ? 'true' : 'false' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || res.statusText)
      }
    } catch (e: unknown) {
      setJobsPaused(!next)
      console.error('[jobs-pause-toggle]', errMsg(e))
    } finally {
      setSaving(false)
    }
  }, [jobsPaused, saving])

  // Three visual states:
  //   1. jobs_paused=true (manual pause) → red, pause icon
  //   2. autoThrottle (burn-rate gate active) → amber, hourglass icon — manual buttons still work, only scheduled fires are skipped
  //   3. neither → default play icon
  const showThrottle = !jobsPaused && autoThrottle != null
  const title = jobsPaused
    ? 'Jobs paused — click to resume'
    : showThrottle
      ? `Scheduled agents auto-paused (7d projects ${autoThrottle!.projectedPct.toFixed(0)}%) — resume ${fmtAbsolute(autoThrottle!.resumesAtMs)}. Click to also pause manual runs.`
      : 'Pause jobs'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={jobsPaused}
      onClick={toggle}
      title={title}
      aria-label={title}
      disabled={loading || saving}
      className={`w-9 h-9 flex items-center justify-center rounded-lg border transition-colors cursor-pointer ${
        jobsPaused
          ? 'border-status-error/60 bg-status-error/10 text-status-error hover:bg-status-error/20'
          : showThrottle
            ? 'border-status-warning/60 bg-status-warning/10 text-status-warning hover:bg-status-warning/20'
            : 'border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
      } ${loading || saving ? 'opacity-70 cursor-wait' : ''}`}
    >
      {jobsPaused ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 5v14" />
          <path d="M16 5v14" />
        </svg>
      ) : showThrottle ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 22h14" />
          <path d="M5 2h14" />
          <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
          <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 3l14 9-14 9V3z" />
        </svg>
      )}
    </button>
  )
}
