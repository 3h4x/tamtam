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

type TimeWindow = '5m' | '15m' | '1h'

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
  windowMs: number
  config: { prometheusUrl: string; lokiUrl: string }
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${ok ? 'bg-status-success' : 'bg-status-error'}`} />
  )
}

function SectionHeader({ title, status }: { title: string; status: 'ok' | 'unavailable' | 'issue' }) {
  const colors = { ok: 'text-status-success', issue: 'text-status-warning', unavailable: 'text-text-tertiary' }
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

// Try to extract a human-readable message from a potentially JSON-heavy log line
function extractLogMessage(line: string): string {
  // Try JSON parse and pull common message fields
  try {
    const parsed = JSON.parse(line)
    const msg =
      parsed.msg ?? parsed.message ?? parsed.error ?? parsed.err ??
      parsed.text ?? parsed.log ?? parsed.body ?? null
    if (typeof msg === 'string' && msg.length > 0) return msg
    // If no known field, return the stringified object but compact
    return line
  } catch {
    return line
  }
}

function LogRow({ entry, color }: { entry: LogLine; color: 'error' | 'warning' }) {
  const [expanded, setExpanded] = useState(false)
  const message = extractLogMessage(entry.line)
  const isLong = message.length > 140
  const display = expanded ? message : message.slice(0, 140)
  const accent = color === 'error' ? 'text-status-error' : 'text-status-warning'

  return (
    <div
      className={`flex gap-3 px-3 py-2 text-xs font-mono border-b border-border/30 last:border-b-0 hover:bg-bg-secondary/50 transition-colors ${expanded ? '' : 'cursor-pointer'}`}
      onClick={() => isLong && setExpanded(e => !e)}
      title={isLong && !expanded ? 'Click to expand' : undefined}
    >
      <span className="text-text-tertiary shrink-0 tabular-nums">{tsToDate(entry.ts)}</span>
      {entry.stream.job && (
        <span className={`${accent} shrink-0 font-medium`}>[{entry.stream.job}]</span>
      )}
      <span className="text-text-primary break-all whitespace-pre-wrap min-w-0 flex-1">
        {display}
        {isLong && !expanded && (
          <span className="text-text-tertiary ml-1 cursor-pointer hover:text-text-secondary">
            …<span className="underline ml-1">expand</span>
          </span>
        )}
        {expanded && isLong && (
          <button
            className="ml-2 text-text-tertiary underline hover:text-text-secondary cursor-pointer border-none bg-transparent text-xs font-mono"
            onClick={e => { e.stopPropagation(); setExpanded(false) }}
          >collapse</button>
        )}
      </span>
    </div>
  )
}

const WINDOW_LABELS: Record<TimeWindow, string> = { '5m': '5 min', '15m': '15 min', '1h': '1 hour' }

export function MonitoringPage() {
  const [data, setData] = useState<MonitoringData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [window_, setWindow] = useState<TimeWindow>('15m')

  const fetch_ = useCallback(async (w: TimeWindow) => {
    try {
      const res = await fetch(`/api/monitoring?window=${w}`)
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
    setLoading(true)
    fetch_(window_)
    const id = setInterval(() => fetch_(window_), 30_000)
    return () => clearInterval(id)
  }, [fetch_, window_])

  const handleWindowChange = (w: TimeWindow) => {
    setWindow(w)
    setLoading(true)
    fetch_(w)
  }

  if (loading && !data) {
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
    data.prometheus.status === 'unavailable' ? 'unavailable'
    : data.prometheus.alerts.length > 0 || downServices.length > 0 ? 'issue'
    : 'ok'

  const lokiStatus =
    data.loki.status === 'unavailable' ? 'unavailable'
    : data.loki.errors.length > 0 ? 'issue'
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
          {loading ? 'Refreshing…' : `Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`}
          {' · auto-refresh 30s'}
        </span>
        {/* Time window selector */}
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

      {/* Prometheus */}
      <section>
        <SectionHeader title="Prometheus" status={promStatus} />
        {data.prometheus.status === 'unavailable' ? (
          <p className="text-sm text-text-tertiary">Not reachable at {data.config.prometheusUrl}</p>
        ) : (
          <div className="space-y-4">
            {data.prometheus.alerts.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-text-secondary mb-2">
                  Firing alerts ({data.prometheus.alerts.length})
                </h3>
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

            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">
                Services ({upServices.length} up{downServices.length > 0 ? `, ${downServices.length} down` : ''})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                {[...downServices, ...upServices].map((s, i) => {
                  const up = s.value?.[1] !== '0'
                  return (
                    <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm ${
                      up ? 'bg-bg-secondary border-border' : 'bg-status-error/5 border-status-error/30'
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
                  <p className="text-sm text-text-tertiary col-span-3">No services found</p>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Loki */}
      <section>
        <SectionHeader title={`Loki — last ${WINDOW_LABELS[window_]}`} status={lokiStatus} />
        {data.loki.status === 'unavailable' ? (
          <p className="text-sm text-text-tertiary">Not reachable at {data.config.lokiUrl}</p>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">
                Errors {data.loki.errors.length > 0 ? `(${data.loki.errors.length})` : '(none)'}
              </h3>
              {data.loki.errors.length === 0 ? (
                <p className="text-sm text-text-tertiary">No errors in the last {WINDOW_LABELS[window_]}</p>
              ) : (
                <div className="rounded-md border border-status-error/30 overflow-hidden overflow-y-auto" style={{ maxHeight: '320px' }}>
                  {data.loki.errors.map((l, i) => (
                    <LogRow key={i} entry={l} color="error" />
                  ))}
                </div>
              )}
            </div>

            {data.loki.warnings.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-text-secondary mb-2">
                  Warnings ({data.loki.warnings.length})
                </h3>
                <div className="rounded-md border border-status-warning/30 overflow-hidden overflow-y-auto" style={{ maxHeight: '320px' }}>
                  {data.loki.warnings.map((l, i) => (
                    <LogRow key={i} entry={l} color="warning" />
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
