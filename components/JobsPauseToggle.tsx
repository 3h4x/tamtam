'use client'

import { useCallback, useEffect, useState } from 'react'
import { errMsg } from '@/lib/shared/types'
import { fmtAbsolute } from '@/lib/shared/format-date'
import { dispatchJobsPausedChanged } from '@/lib/shared/jobs-paused-events'
import { dispatchSettingsChanged, subscribeToSettingsChanged } from '@/lib/shared/settings-events'

interface QuotaWindow { utilization: number; resetsAt: string | null; msUntilReset: number | null }
interface SchedulerThrottle {
  reason: string
  projectedPct: number
  worstProvider: string
  resumesAtMs: number | null
}
interface QuotaSnapshot {
  fiveHour: QuotaWindow
  sevenDay: QuotaWindow
  gateEnabled?: boolean
  schedulerThrottle?: SchedulerThrottle | null
}

export function JobsPauseToggle() {
  const [jobsPaused, setJobsPaused] = useState(false)
  const [rebuildInProgress, setRebuildInProgress] = useState(false)
  const [budgetGateEnabled, setBudgetGateEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [autoThrottle, setAutoThrottle] = useState<SchedulerThrottle | null>(null)
  const [quotaRefreshSeq, setQuotaRefreshSeq] = useState(0)

  useEffect(() => {
    let live = true
    const applySettings = (
      settings: Record<string, string | undefined>,
      { merge }: { merge: boolean },
    ) => {
      if (!merge || 'jobs_paused' in settings) {
        setJobsPaused(settings.jobs_paused === 'true')
      }
      if (!merge || 'rebuild_in_progress' in settings) {
        setRebuildInProgress(settings.rebuild_in_progress === 'true')
      }
      if (!merge || 'budget_block_runs_enabled' in settings) {
        const enabled = settings.budget_block_runs_enabled === 'true'
        setBudgetGateEnabled(enabled)
        if (!enabled) setAutoThrottle(null)
      }
    }
    // Poll /api/settings so the chip reflects out-of-band changes — the
    // rebuild-safe.sh script PATCHes rebuild_in_progress server-side via
    // curl, which never fires the in-browser settings-changed event. 5s
    // is short enough that "rebuilding…" appears almost immediately when
    // the script flips the flag, and disappears just as fast on unpause.
    //
    // `initial=true` handles the loading->false transition + catches map to
    // a safe "jobs running" default. Recurring polls stay silent on transient
    // errors so the chip doesn't flicker mid-rebuild.
    const fetchSettings = async (initial: boolean) => {
      try {
        const res = await fetch('/api/settings')
        if (!initial && !res.ok) return
        const data = await res.json()
        if (!live) return
        applySettings(data.settings ?? {}, { merge: false })
      } catch {
        if (initial && live) setJobsPaused(false)
      } finally {
        if (initial && live) setLoading(false)
      }
    }
    void fetchSettings(true)
    const pollId = setInterval(() => fetchSettings(false), 5_000)
    const unsubscribe = subscribeToSettingsChanged((settings) => {
      if (!live) return
      applySettings(settings, { merge: true })
      setQuotaRefreshSeq((seq) => seq + 1)
    })
    return () => {
      live = false
      clearInterval(pollId)
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let live = true
    if (!budgetGateEnabled) {
      return () => {
        live = false
      }
    }
    const loadQuota = async () => {
      try {
        const res = await fetch('/api/usage/quota')
        if (!res.ok) return
        const snap = (await res.json()) as QuotaSnapshot
        if (!live) return
        // Only flag throttle when the server-side gate is enabled — otherwise
        // the indicator would lie about scheduled agents being paused.
        // The server now computes the multi-provider verdict so we don't
        // light up "scheduled paused" when one provider is over but a sibling
        // (e.g. Codex) still has weekly headroom.
        if (!snap.gateEnabled) { setAutoThrottle(null); return }
        setAutoThrottle(snap.schedulerThrottle ?? null)
      } catch {
        // ignore — fail open
      }
    }
    void loadQuota()
    const id = setInterval(loadQuota, 300_000)
    return () => { live = false; clearInterval(id) }
  }, [budgetGateEnabled, quotaRefreshSeq])

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
      const data = await res.json().catch(() => ({}))
      dispatchSettingsChanged(data.settings ?? {
        jobs_paused: next ? 'true' : 'false',
        budget_block_runs_enabled: budgetGateEnabled ? 'true' : 'false',
      })
      dispatchJobsPausedChanged(next)
    } catch (e: unknown) {
      setJobsPaused(!next)
      console.error('[jobs-pause-toggle]', errMsg(e))
    } finally {
      setSaving(false)
    }
  }, [budgetGateEnabled, jobsPaused, saving])

  // Four visible states (rebuild takes precedence over manual pause —
  // when the rebuild script has set both flags, the user needs to know
  // it's a transient rebuild, not a manual pause they should resume):
  //   1. rebuild_in_progress=true → "rebuilding…" with spinner glyph; click disabled
  //   2. jobs_paused=true (manual pause) → "jobs paused"
  //   3. autoThrottle (burn-rate gate active) → "scheduled paused"; manual buttons still work
  //   4. neither → "jobs running"
  const showRebuild = rebuildInProgress
  const showThrottle = !jobsPaused && !showRebuild && autoThrottle != null
  const label = showRebuild
    ? 'rebuilding…'
    : jobsPaused
      ? 'jobs paused'
      : showThrottle
        ? 'scheduled paused'
        : 'jobs running'
  const title = showRebuild
    ? 'Rebuild in progress — jobs are paused by scripts/rebuild-safe.sh and will resume automatically when the build + restart finishes.'
    : jobsPaused
      ? 'Jobs paused — click to resume'
      : showThrottle
        ? `Scheduled agents paused — every enabled provider over weekly budget (worst: ${autoThrottle!.worstProvider} at ${autoThrottle!.projectedPct.toFixed(0)}%${autoThrottle!.resumesAtMs ? `, resume ${fmtAbsolute(autoThrottle!.resumesAtMs)}` : ''}). Click to also pause manual runs.`
        : 'Pause jobs'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={jobsPaused}
      onClick={showRebuild ? undefined : toggle}
      title={title}
      aria-label={title}
      disabled={loading || saving || showRebuild}
      className={`h-9 px-3 flex items-center justify-center gap-1.5 rounded-lg border transition-colors text-xs font-medium whitespace-nowrap ${
        showRebuild
          ? 'border-accent/60 bg-accent/10 text-accent cursor-wait'
          : jobsPaused
            ? 'border-status-error/60 bg-status-error/10 text-status-error hover:bg-status-error/20 cursor-pointer'
            : showThrottle
              ? 'border-status-warning/60 bg-status-warning/10 text-status-warning hover:bg-status-warning/20 cursor-pointer'
              : 'border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary cursor-pointer'
      } ${(loading || saving) && !showRebuild ? 'opacity-70 cursor-wait' : ''}`}
    >
      {showRebuild && (
        <span className="animate-spin leading-none" aria-hidden="true">{'⟳'}</span>
      )}
      {label}
    </button>
  )
}
