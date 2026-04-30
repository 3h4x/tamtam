'use client'

import { useCallback, useEffect, useState } from 'react'
import { errMsg } from '@/lib/types'

export function JobsPauseToggle() {
  const [jobsPaused, setJobsPaused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

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

  return (
    <button
      type="button"
      role="switch"
      aria-checked={jobsPaused}
      onClick={toggle}
      title={jobsPaused ? 'Resume jobs' : 'Pause jobs'}
      aria-label={jobsPaused ? 'Resume jobs' : 'Pause jobs'}
      disabled={loading || saving}
      className={`w-9 h-9 flex items-center justify-center rounded-lg border transition-colors cursor-pointer ${
        jobsPaused
          ? 'border-status-error/60 bg-status-error/10 text-status-error hover:bg-status-error/20'
          : 'border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
      } ${loading || saving ? 'opacity-70 cursor-wait' : ''}`}
    >
      {jobsPaused ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 5v14" />
          <path d="M16 5v14" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 3l14 9-14 9V3z" />
        </svg>
      )}
    </button>
  )
}
