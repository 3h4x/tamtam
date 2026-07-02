'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePolling } from '@/hooks/usePolling'
import { Button, type ButtonVariant } from '@/components/ui/Button'
import { InlineLoading } from '@/components/ui/InlineLoading'
import { useToast } from '@/components/Toast'
import { errMsg } from '@/lib/shared/types'
import { fmtAbsolute } from '@/lib/shared/format-date'
import { dispatchJobsPausedChanged } from '@/lib/shared/jobs-paused-events'
import { dispatchSettingsChanged, subscribeToSettingsChanged } from '@/lib/shared/settings-events'
import { fetchSettings, invalidateSettings } from '@/lib/client-api'

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
  const { toast } = useToast()
  const [jobsPaused, setJobsPaused] = useState(false)
  const [rebuildInProgress, setRebuildInProgress] = useState(false)
  const [budgetGateEnabled, setBudgetGateEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [autoThrottle, setAutoThrottle] = useState<SchedulerThrottle | null>(null)
  const [quotaRefreshSeq, setQuotaRefreshSeq] = useState(0)

  const applySettings = useCallback((
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
  }, [])

  // Initial load + out-of-band change subscription. The initial fetch maps a
  // failure to a safe "jobs running" default and clears the loading state.
  useEffect(() => {
    let live = true
    const fetchInitial = async () => {
      try {
        const data = await fetchSettings()
        if (!live) return
        applySettings(data.settings ?? {}, { merge: false })
      } catch {
        if (live) setJobsPaused(false)
      } finally {
        if (live) setLoading(false)
      }
    }
    void fetchInitial()
    const unsubscribe = subscribeToSettingsChanged((settings) => {
      if (!live) return
      applySettings(settings, { merge: true })
      setQuotaRefreshSeq((seq) => seq + 1)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [applySettings])

  // Poll /api/settings so the chip reflects out-of-band changes — the
  // rebuild-safe.sh script PATCHes rebuild_in_progress server-side via curl,
  // which never fires the in-browser settings-changed event. 5s is short enough
  // that "rebuilding…" appears almost immediately when the script flips the
  // flag, and disappears just as fast on unpause. Throwing on a non-ok response
  // lets usePolling back off (instead of hammering) when the server is wedged;
  // transient failures leave the chip state untouched so it doesn't flicker.
  const pollSettings = useCallback(async () => {
    // force: always fetch fresh — this poll exists to catch out-of-band changes
    // (e.g. rebuild-safe.sh flipping rebuild_in_progress server-side), which a
    // cached read would miss. Throws on non-ok so usePolling backs off.
    const data = await fetchSettings({ force: true })
    applySettings(data.settings ?? {}, { merge: false })
  }, [applySettings])

  usePolling(pollSettings, { intervalMs: 5_000, immediate: false })

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
      invalidateSettings()
      dispatchSettingsChanged(data.settings ?? {
        jobs_paused: next ? 'true' : 'false',
        budget_block_runs_enabled: budgetGateEnabled ? 'true' : 'false',
      })
      dispatchJobsPausedChanged(next)
    } catch (e: unknown) {
      const message = errMsg(e)
      setJobsPaused(!next)
      toast(message || 'Failed to update jobs pause state', 'error')
      console.error('[jobs-pause-toggle]', message)
    } finally {
      setSaving(false)
    }
  }, [budgetGateEnabled, jobsPaused, saving, toast])

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
  const buttonVariant: ButtonVariant = showRebuild
    ? 'primary'
    : jobsPaused
      ? 'danger'
      : showThrottle
        ? 'warning'
        : 'secondary'

  return (
    <Button
      type="button"
      variant={buttonVariant}
      role="switch"
      aria-checked={jobsPaused}
      onClick={showRebuild ? undefined : toggle}
      title={title}
      aria-label={title}
      disabled={loading || saving || showRebuild}
      disabledCursor="wait"
      className={[
        'h-9 justify-center rounded-lg text-xs whitespace-nowrap',
        showRebuild ? 'cursor-wait hover:bg-accent/10' : '',
        jobsPaused ? 'bg-status-error/10' : '',
        !jobsPaused && !showThrottle && !showRebuild ? 'text-text-secondary hover:text-text-primary' : '',
        (loading || saving) && !showRebuild ? 'opacity-70 cursor-wait' : '',
      ].filter(Boolean).join(' ')}
    >
      {showRebuild ? (
        <InlineLoading
          label={label}
          className="!gap-1.5 !text-xs text-current [&_[role=status]]:!h-3 [&_[role=status]]:!w-3 [&_[role=status]]:!border-[1.5px]"
        />
      ) : label}
    </Button>
  )
}
