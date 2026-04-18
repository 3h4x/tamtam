'use client'

import { useEffect, useState, useCallback } from 'react'

interface PrometheusResult {
  metric: Record<string, string>
  value: [number, string]
}

interface LogLine {
  ts: string
  stream: Record<string, string>
  line: string
}

interface MonitoringData {
  prometheus: {
    status: 'ok' | 'unavailable'
    alerts: PrometheusResult[]
    services: PrometheusResult[]
  }
  loki: {
    status: 'ok' | 'unavailable'
    errors: LogLine[]
    warnings: LogLine[]
  }
  hasIssues: boolean
  fetchedAt: number
  config: { prometheusUrl: string; lokiUrl: string }
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-status-success' : 'bg-status-error'}`}
    />
  )
}

function SectionHeader({ title, status }: { title: string; status: 'ok' | 'unavailable' | 'issue' }) {
  const colors = {
    ok: 'text-status-success',
    issue: 'text-status-warning',
    unavailable: 'text-text-tertiary',
  }
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <span className={`text-xs font-medium ${colors[status]}`}>
        {status === 'ok' ? '● ok' : status === 'unavailable' ? '● unavailable' : '● issues'}
      </span>
    </div>
  )
}

function tsToDate(ts: string): string {
  const ms = Math.floor(Number(ts) / 1_000_000)
  return new Date(ms).toLocaleTimeString()
}

export function MonitoringPage() {
  const [data, setData] = useState<MonitoringData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/monitoring')
      if (!res.ok) throw new Error('fetch failed')
      setData(await res.json())
      setError(null)
    } catch {
      setError('Failed to fetch monitoring data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch_()
    const id = setInterval(fetch_, 30_000)
    return () => clearInterval(id)
  }, [fetch_])

  if (loading) {
    return (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-8">
        <div className="skeleton h-11 w-full rounded-lg" />
        <div className="space-y-3">
          <div className="skeleton h-5 w-32" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-10 rounded-md" />)}
          </div>
        </div>
        <div className="space-y-3">
          <div className="skeleton h-5 w-24" />
          <div className="skeleton h-20 rounded-md" />
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-64 text-status-error text-sm">
        {error ?? 'No data'}
      </div>
    )
  }

  const downServices = data.prometheus.services.filter(s => s.value?.[1] === '0')
  const upServices = data.prometheus.services.filter(s => s.value?.[1] !== '0')

  const promStatus =
    data.prometheus.status === 'unavailable'
      ? 'unavailable'
      : data.prometheus.alerts.length > 0 || downServices.length > 0
      ? 'issue'
      : 'ok'

  const lokiStatus =
    data.loki.status === 'unavailable'
      ? 'unavailable'
      : data.loki.errors.length > 0
      ? 'issue'
      : 'ok'

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-8">
      {/* Summary bar */}
      <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border text-sm font-medium ${
        data.hasIssues
          ? 'border-status-warning/40 bg-status-warning/5 text-status-warning'
          : 'border-status-success/40 bg-status-success/5 text-status-success'
      }`}>
        <StatusDot ok={!data.hasIssues} />
        {data.hasIssues ? 'Issues detected — review below' : 'All systems OK'}
        <span className="ml-auto text-xs opacity-60">
          Updated {new Date(data.fetchedAt).toLocaleTimeString()} · auto-refresh 30s
        </span>
        <button
          onClick={fetch_}
          className="text-xs px-2 py-0.5 rounded border border-current opacity-60 hover:opacity-100 transition-opacity"
        >
          Refresh
        </button>
      </div>

      {/* Prometheus */}
      <section>
        <SectionHeader title="Prometheus" status={promStatus} />
        {data.prometheus.status === 'unavailable' ? (
          <p className="text-sm text-text-tertiary">Not reachable at {data.config.prometheusUrl}</p>
        ) : (
          <div className="space-y-4">
            {/* Firing alerts */}
            {data.prometheus.alerts.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-text-secondary mb-2">Firing alerts ({data.prometheus.alerts.length})</h3>
                <div className="space-y-1">
                  {data.prometheus.alerts.map((a, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-md bg-status-error/5 border border-status-error/30 text-sm">
                      <span className="text-status-error font-medium">{a.metric.alertname ?? 'Alert'}</span>
                      {a.metric.severity && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-status-error/10 text-status-error">
                          {a.metric.severity}
                        </span>
                      )}
                      {a.metric.instance && (
                        <span className="text-text-tertiary text-xs ml-auto">{a.metric.instance}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Services */}
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">
                Services ({upServices.length} up{downServices.length > 0 ? `, ${downServices.length} down` : ''})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {[...downServices, ...upServices].map((s, i) => {
                  const up = s.value?.[1] !== '0'
                  return (
                    <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm ${
                      up
                        ? 'bg-bg-secondary border-border'
                        : 'bg-status-error/5 border-status-error/30'
                    }`}>
                      <StatusDot ok={up} />
                      <span className="font-medium text-text-primary truncate">{s.metric.job ?? s.metric.instance ?? 'unknown'}</span>
                      {s.metric.instance && s.metric.job && (
                        <span className="text-text-tertiary text-xs ml-auto truncate">{s.metric.instance}</span>
                      )}
                    </div>
                  )
                })}
                {data.prometheus.services.length === 0 && (
                  <p className="text-sm text-text-tertiary col-span-2">No services found</p>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Loki */}
      <section>
        <SectionHeader title="Loki — last 15 min" status={lokiStatus} />
        {data.loki.status === 'unavailable' ? (
          <p className="text-sm text-text-tertiary">Not reachable at {data.config.lokiUrl}</p>
        ) : (
          <div className="space-y-4">
            {/* Errors */}
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">
                Errors {data.loki.errors.length > 0 ? `(${data.loki.errors.length})` : '(none)'}
              </h3>
              {data.loki.errors.length === 0 ? (
                <p className="text-sm text-text-tertiary">No errors in the last 15 minutes</p>
              ) : (
                <div className="rounded-md border border-status-error/30 overflow-hidden">
                  {data.loki.errors.map((l, i) => (
                    <div key={i} className={`flex gap-3 px-3 py-1.5 text-xs font-mono ${i % 2 === 0 ? 'bg-bg-primary' : 'bg-bg-secondary'}`}>
                      <span className="text-text-tertiary shrink-0 pt-px">{tsToDate(l.ts)}</span>
                      {l.stream.job && (
                        <span className="text-accent shrink-0 pt-px">[{l.stream.job}]</span>
                      )}
                      <span className="text-text-primary break-all">{l.line}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Warnings */}
            {data.loki.warnings.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-text-secondary mb-2">
                  Warnings ({data.loki.warnings.length})
                </h3>
                <div className="rounded-md border border-status-warning/30 overflow-hidden">
                  {data.loki.warnings.map((l, i) => (
                    <div key={i} className={`flex gap-3 px-3 py-1.5 text-xs font-mono ${i % 2 === 0 ? 'bg-bg-primary' : 'bg-bg-secondary'}`}>
                      <span className="text-text-tertiary shrink-0 pt-px">{tsToDate(l.ts)}</span>
                      {l.stream.job && (
                        <span className="text-status-warning shrink-0 pt-px">[{l.stream.job}]</span>
                      )}
                      <span className="text-text-primary break-all">{l.line}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
