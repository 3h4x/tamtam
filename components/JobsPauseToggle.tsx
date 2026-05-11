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
      if (!merge || 'budget_block_runs_enabled' in settings) {
        setBudgetGateEnabled(settings.budget_block_runs_enabled === 'true')
      }
    }
    const load = async () => {
      try {
        const res = await fetch('/api/settings')
        const data = await res.json()
        if (!live) return
        applySettings(data.settings ?? {}, { merge: false })
      } catch {
        if (live) setJobsPaused(false)
      } finally {
        if (live) setLoading(false)
      }
    }
    void load()
    const unsubscribe = subscribeToSettingsChanged((settings) => {
      if (!live) return
      applySettings(settings, { merge: true })
      setQuotaRefreshSeq((seq) => seq + 1)
    })
    return () => {
      live = false
      unsubscribe()
    }
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
        // The server now computes the multi-provider verdict so we don't
        // light up "scheduled paused" when one provider is over but a sibling
        // (e.g. Codex) still has weekly headroom.
        if (!budgetGateEnabled || !snap.gateEnabled) { setAutoThrottle(null); return }
        setAutoThrottle(snap.schedulerThrottle ?? null)
      } catch {
        // ignore — fail open
      }
    }
    void loadQuota()
    const id = setInterval(loadQuota, 60_000)
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

  // Three visible states:
  //   1. jobs_paused=true (manual pause) → "jobs paused"
  //   2. autoThrottle (burn-rate gate active) → "scheduled paused"; manual buttons still work
  //   3. neither → "jobs running"
  const showThrottle = !jobsPaused && autoThrottle != null
  const label = jobsPaused
    ? 'jobs paused'
    : showThrottle
      ? 'scheduled paused'
      : 'jobs running'
  const title = jobsPaused
    ? 'Jobs paused — click to resume'
    : showThrottle
      ? `Scheduled agents paused — every enabled provider over weekly budget (worst: ${autoThrottle!.worstProvider} at ${autoThrottle!.projectedPct.toFixed(0)}%${autoThrottle!.resumesAtMs ? `, resume ${fmtAbsolute(autoThrottle!.resumesAtMs)}` : ''}). Click to also pause manual runs.`
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
      className={`h-9 px-3 flex items-center justify-center rounded-lg border transition-colors cursor-pointer text-xs font-medium whitespace-nowrap ${
        jobsPaused
          ? 'border-status-error/60 bg-status-error/10 text-status-error hover:bg-status-error/20'
          : showThrottle
            ? 'border-status-warning/60 bg-status-warning/10 text-status-warning hover:bg-status-warning/20'
            : 'border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
      } ${loading || saving ? 'opacity-70 cursor-wait' : ''}`}
    >
      {label}
    </button>
  )
}
