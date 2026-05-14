'use client'

import { useState, useCallback, useEffect } from 'react'
import { SectionHeader } from './shared'
import { SchedulerFireTable } from './SchedulerFireTable'
import type { SchedulerInternalEntry } from './SchedulerFireTable'

interface SchedulerExpected {
  id: string
  project: string
  name: string
  runner: string
  schedule: string
  expectedName: string
}

interface SchedulerHealth {
  ok: boolean
  expected: SchedulerExpected[]
  actual: { pm2: string[] }
  missing: SchedulerExpected[]
  orphans: { pm2: string[] }
  errors: string[]
  internal?: { started: boolean; entries: SchedulerInternalEntry[] }
}

export function SchedulerHealthPanel() {
  const [health, setHealth] = useState<SchedulerHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [reconciling, setReconciling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/agents/scheduler-health')
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`)
      setHealth(await r.json())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const reconcile = async () => {
    setReconciling(true)
    try {
      const r = await fetch('/api/agents/scheduler-health', { method: 'POST' })
      if (r.ok) {
        const body = await r.json()
        setHealth(body.after)
      }
    } finally {
      setReconciling(false)
    }
  }

  const status: 'ok' | 'issue' | 'unavailable' = error ? 'unavailable' : health?.ok ? 'ok' : 'issue'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <SectionHeader title="Scheduled agents" status={status} />
        <div className="flex gap-2">
          <button
            onClick={load}
            className="text-[11px] px-2 py-1 rounded border border-border text-text-tertiary hover:text-text-secondary bg-transparent cursor-pointer transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={reconcile}
            disabled={reconciling || !health || health.ok}
            className="text-[11px] px-2 py-1 rounded border border-border text-text-tertiary hover:text-text-secondary bg-transparent cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {reconciling ? 'Reconciling…' : 'Reconcile'}
          </button>
        </div>
      </div>
      {loading && !health ? (
        <div className="skeleton h-16 rounded-md" />
      ) : error ? (
        <p className="text-sm text-status-error">{error}</p>
      ) : health ? (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-text-tertiary">
            <span>Expected: <span className="text-text-primary font-medium">{health.expected.length}</span></span>
            <span>Internal armed: <span className="text-text-primary font-medium">{health.actual.pm2.length}</span></span>
            {health.missing.length > 0 && <span className="text-status-error">Missing: {health.missing.length}</span>}
            {health.orphans.pm2.length > 0 && (
              <span className="text-status-warning">Orphans: {health.orphans.pm2.length}</span>
            )}
          </div>

          {health.errors.length > 0 && (
            <div className="rounded-md border border-status-error/30 bg-status-error/5 p-2 space-y-1">
              {health.errors.map((e, i) => (
                <div key={i} className="text-xs text-status-error font-mono">{e}</div>
              ))}
            </div>
          )}

          {health.missing.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-status-error mb-1">Missing (in DB but not loaded)</h3>
              <div className="rounded-md border border-status-error/30 overflow-hidden">
                {health.missing.map(m => (
                  <div key={m.id} className="flex items-center gap-3 px-3 py-1.5 text-xs font-mono border-t border-status-error/20 first:border-t-0">
                    <span className="text-text-tertiary uppercase tracking-wide w-16 shrink-0">{m.runner}</span>
                    <span className="text-text-primary truncate" data-private>{m.expectedName}</span>
                    <span className="text-text-tertiary ml-auto shrink-0">{m.schedule}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {health.orphans.pm2.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-status-warning mb-1">Orphans (loaded but not in DB)</h3>
              <div className="rounded-md border border-status-warning/30 overflow-hidden">
                {health.orphans.pm2.map(n => (
                  <div key={`pm2:${n}`} className="flex items-center gap-3 px-3 py-1.5 text-xs font-mono border-t border-status-warning/20 first:border-t-0">
                    <span className="text-text-tertiary uppercase tracking-wide w-16 shrink-0">pm2</span>
                    <span className="text-text-primary truncate" data-private>{n}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {health.ok && (
            <p className="text-xs text-status-success">All scheduled agents are armed in the internal scheduler.</p>
          )}

          {health.internal && health.internal.entries.length > 0 && (
            <SchedulerFireTable entries={health.internal.entries} />
          )}
        </div>
      ) : null}
    </div>
  )
}
