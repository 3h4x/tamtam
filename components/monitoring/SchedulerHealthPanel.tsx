'use client'

import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { InlineLoading } from '@/components/ui/InlineLoading'
import { SectionHeader } from './shared'
import { SchedulerFireTable } from './SchedulerFireTable'
import type { SchedulerInternalEntry } from './SchedulerFireTable'

interface SchedulerExpected {
  id: string
  project: string
  name: string
  schedule: string
  expectedName: string
  queueKey: string
  promptFileLoaded?: boolean
  queueLoaded?: boolean
}

interface SchedulerHealth {
  ok: boolean
  expected: SchedulerExpected[]
  actual: { graphile: string[] }
  missing: SchedulerExpected[]
  orphans: { graphile: string[] }
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

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

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
          <Button
            variant="ghost"
            size="sm"
            onClick={load}
          >
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={reconcile}
            disabled={reconciling || !health || health.ok}
          >
            {reconciling ? 'Reconciling…' : 'Reconcile'}
          </Button>
        </div>
      </div>
      {loading && !health ? (
        <div className="rounded-md border border-border bg-bg-secondary p-3">
          <InlineLoading label="Loading scheduler health..." />
        </div>
      ) : error ? (
        <ErrorCallout className="text-sm">{error}</ErrorCallout>
      ) : health ? (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-text-tertiary">
            <span>Expected: <span className="text-text-primary font-medium">{health.expected.length}</span></span>
            <span>Queued: <span className="text-text-primary font-medium">{health.actual.graphile.length}</span></span>
            {health.missing.length > 0 && <span className="text-status-error">Missing: {health.missing.length}</span>}
          </div>

          {health.errors.length > 0 && (
            <ErrorCallout className="space-y-1">
              {health.errors.map((e, i) => (
                <div key={i} className="text-xs text-status-error font-mono">{e}</div>
              ))}
            </ErrorCallout>
          )}

          {health.missing.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-status-error mb-1">Missing (prompt file or queue job not loaded)</h3>
              <div className="rounded-md border border-status-error/30 overflow-hidden">
                {health.missing.map(m => (
                  <div key={m.id} className="flex items-center gap-3 px-3 py-1.5 text-xs font-mono border-t border-status-error/20 first:border-t-0">
                    <span className="text-text-primary truncate" data-private>{m.expectedName}</span>
                    <span className="text-text-tertiary shrink-0">
                      {!m.promptFileLoaded ? 'prompt' : ''}
                      {!m.promptFileLoaded && !m.queueLoaded ? '+' : ''}
                      {!m.queueLoaded ? 'queue' : ''}
                    </span>
                    <span className="text-text-tertiary ml-auto shrink-0">{m.schedule}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {health.ok && (
            <p className="text-xs text-status-success">All scheduled agents have prompt files and Graphile queue jobs ready.</p>
          )}

          {health.internal && health.internal.entries.length > 0 && (
            <SchedulerFireTable entries={health.internal.entries} />
          )}
        </div>
      ) : null}
    </div>
  )
}
