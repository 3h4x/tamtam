'use client'

import { useEffect, useState, useCallback } from 'react'
import { ErrorState } from './ErrorState'
import type { MonitoringData, TimeWindow, MonitoringTab } from '@/components/monitoring/types'
import { Pm2LogPanel } from '@/components/monitoring/Pm2LogPanel'
import type { Pm2LogData } from '@/components/monitoring/Pm2LogPanel'
import { SchedulerHealthPanel } from '@/components/monitoring/SchedulerHealthPanel'
import { OverviewTab } from '@/components/monitoring/OverviewTab'
import { InfraTab } from '@/components/monitoring/InfraTab'
import { StatusDot } from '@/components/monitoring/shared'
import { StandardTabs } from '@/components/ui/StandardTabs'
import type { StandardTabItem } from '@/components/ui/StandardTabs'

interface ReadinessCheck {
  name: string
  ok: boolean
  severity: 'info' | 'warn' | 'error'
  message: string
}

interface ReadinessData {
  status: string
  ok: boolean
  checks: ReadinessCheck[]
}

function TabBadge({ count, variant }: { count: number; variant: 'error' | 'warn' | 'ok' }) {
  if (count === 0) return null
  const cls =
    variant === 'error' ? 'bg-status-error/15 text-status-error' :
    variant === 'warn'  ? 'bg-status-warning/15 text-status-warning' :
    'bg-status-success/15 text-status-success'
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}>{count}</span>
  )
}

function ReadinessPanel({ readiness }: { readiness: ReadinessData | null }) {
  if (!readiness) return null
  const tone = readiness.ok
    ? 'border-status-success/40 bg-status-success/5'
    : 'border-status-warning/40 bg-status-warning/5'
  const badge = (item: ReadinessCheck) => {
    if (item.ok) return 'bg-status-success/15 text-status-success'
    return item.severity === 'error'
      ? 'bg-status-error/15 text-status-error'
      : 'bg-status-warning/15 text-status-warning'
  }
  return (
    <div className={`rounded-lg border ${tone} p-4`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text-primary">Readiness checks</div>
          <div className="text-xs text-text-tertiary mt-0.5">
            {readiness.ok ? 'Required local dependencies are available' : 'One or more checks need attention'}
          </div>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full ${readiness.ok ? 'bg-status-success/15 text-status-success' : 'bg-status-warning/15 text-status-warning'}`}>
          {readiness.status}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
        {readiness.checks.map((item) => (
          <div key={item.name} className="rounded-md border border-border bg-bg-primary px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-text-primary">{item.name}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${badge(item)}`}>
                {item.ok ? 'pass' : item.severity}
              </span>
            </div>
            <div className="text-xs text-text-tertiary mt-1">{item.message}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function MonitoringPage() {
  const [data, setData] = useState<MonitoringData | null>(null)
  const [pm2Logs, setPm2Logs] = useState<Pm2LogData | null>(null)
  const [readiness, setReadiness] = useState<ReadinessData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [window_, setWindow] = useState<TimeWindow>('15m')
  const [activeTab, setActiveTab] = useState<MonitoringTab>('overview')

  const fetchPm2Logs = useCallback(async () => {
    try {
      const res = await fetch('/api/monitoring/pm2-logs?limit=200')
      if (res.ok) setPm2Logs(await res.json())
    } catch { /* non-fatal */ }
  }, [])

  const fetch_ = useCallback(async (w: TimeWindow) => {
    try {
      const [monRes, pm2Res] = await Promise.all([
        fetch(`/api/monitoring?window=${w}`),
        fetch(`/api/monitoring/pm2-logs?limit=200`),
      ])
      if (!monRes.ok) throw new Error('fetch failed')
      setData(await monRes.json())
      if (pm2Res.ok) setPm2Logs(await pm2Res.json())
      setError(null)
    } catch {
      setError('Failed to fetch monitoring data')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchReadiness = useCallback(async () => {
    try {
      const res = await fetch('/api/health?deep=1')
      const body = await res.json().catch(() => null) as ReadinessData | null
      if (body?.checks) setReadiness(body)
    } catch {
      setReadiness(null)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetch_(window_)
    fetchReadiness()
    const id = setInterval(() => fetch_(window_), 30_000)
    const readinessId = setInterval(fetchReadiness, 60_000)
    return () => {
      clearInterval(id)
      clearInterval(readinessId)
    }
  }, [fetch_, fetchReadiness, window_])

  const handleWindowChange = (w: TimeWindow) => {
    setWindow(w)
    setLoading(true)
    fetch_(w)
  }

  if (loading && !data) {
    return (
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="skeleton h-11 w-full rounded-lg" />
        <div className="flex gap-1">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-9 w-24 rounded-md" />)}
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-24 rounded-lg" />)}
          </div>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="max-w-5xl mx-auto">
        <ErrorState
          message={error ?? 'Monitoring data is not available.'}
          hint="Make sure Prometheus and Loki are reachable from the TamTam server."
          onRetry={() => { setLoading(true); fetch_(window_) }}
        />
      </div>
    )
  }

  // Badge counts for tabs
  const pm2ErrorCount  = pm2Logs?.entries.filter(e => e.level === 'error').length ?? 0
  const pm2WarnCount   = pm2Logs?.entries.filter(e => e.level === 'warn').length ?? 0
  const lokiErrorCount = data.loki.errors.length
  const downCount      = data.prometheus.services.filter(s => s.value?.[1] === '0').length
  const alertCount     = data.prometheus.alerts.length
  const infraIssues    = lokiErrorCount + downCount + alertCount

  const tabs: StandardTabItem<MonitoringTab>[] = [
    {
      id: 'overview',
      label: 'Overview',
      badge: data.hasIssues
        ? <TabBadge count={pm2ErrorCount + infraIssues} variant="error" />
        : undefined,
    },
    {
      id: 'agents',
      label: 'Agents',
    },
    {
      id: 'logs',
      label: 'Logs',
      badge: pm2ErrorCount > 0
        ? <TabBadge count={pm2ErrorCount} variant="error" />
        : pm2WarnCount > 0
        ? <TabBadge count={pm2WarnCount} variant="warn" />
        : undefined,
    },
    {
      id: 'infra',
      label: 'Infra',
      badge: infraIssues > 0
        ? <TabBadge count={infraIssues} variant="error" />
        : undefined,
    },
  ]

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Summary bar */}
      <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border text-sm font-medium ${
        data.hasIssues
          ? 'border-status-warning/40 bg-status-warning/5 text-status-warning'
          : 'border-status-success/40 bg-status-success/5 text-status-success'
      }`}>
        <StatusDot ok={!data.hasIssues} />
        {data.hasIssues ? 'Issues detected — review below' : 'All systems OK'}
        <span className="ml-auto text-xs opacity-60">
          {loading ? 'Refreshing…' : `Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`}
          {' · auto-refresh 30s'}
        </span>
        <div className="flex items-center gap-0.5 rounded border border-current/20 overflow-hidden">
          {(['5m', '15m', '1h'] as TimeWindow[]).map(w => (
            <button
              key={w}
              className={`text-xs px-2 py-0.5 border-none cursor-pointer font-medium transition-colors ${
                window_ === w
                  ? 'bg-current/20 text-current'
                  : 'text-current/50 hover:text-current/80 bg-transparent'
              }`}
              onClick={() => handleWindowChange(w)}
            >
              {w}
            </button>
          ))}
        </div>
        <button
          onClick={() => fetch_(window_)}
          className="text-xs px-2 py-0.5 rounded border border-current opacity-60 hover:opacity-100 transition-opacity cursor-pointer bg-transparent"
        >
          Refresh
        </button>
      </div>

      {/* Tab bar */}
      <StandardTabs
        items={tabs}
        activeTab={activeTab}
        ariaLabel="Monitoring tabs"
        onChange={setActiveTab}
      />

      {/* Tab panels */}
      <div>
        {activeTab === 'overview' && (
          <div className="space-y-4">
            <ReadinessPanel readiness={readiness} />
            <OverviewTab data={data} pm2Logs={pm2Logs} window_={window_} />
          </div>
        )}
        {activeTab === 'agents' && (
          <SchedulerHealthPanel />
        )}
        {activeTab === 'logs' && (
          <Pm2LogPanel pm2Logs={pm2Logs} onRefresh={fetchPm2Logs} />
        )}
        {activeTab === 'infra' && (
          <InfraTab data={data} window_={window_} />
        )}
      </div>
    </div>
  )
}
