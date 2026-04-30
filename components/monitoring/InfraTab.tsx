'use client'

import { useState } from 'react'
import { SectionHeader } from './shared'
import type { MonitoringData, TimeWindow } from './types'
import { WINDOW_LABELS } from './types'

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${ok ? 'bg-status-success' : 'bg-status-error'}`} />
  )
}

function tsToDate(ts: string): string {
  const ms = Math.floor(Number(ts) / 1_000_000)
  return new Date(ms).toLocaleTimeString()
}

function extractLogMessage(line: string): string {
  try {
    const parsed = JSON.parse(line)
    const msg =
      parsed.msg ?? parsed.message ?? parsed.error ?? parsed.err ??
      parsed.text ?? parsed.log ?? parsed.body ?? null
    if (typeof msg === 'string' && msg.length > 0) return msg
    return line
  } catch {
    return line
  }
}

function LogRow({ entry, color }: { entry: { ts: string; stream: Record<string, string>; line: string }; color: 'error' | 'warning' }) {
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
        <span className={`${accent} shrink-0 font-medium`} data-private>[{entry.stream.job}]</span>
      )}
      <span className="text-text-primary break-all whitespace-pre-wrap min-w-0 flex-1" data-private>
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

export function InfraTab({ data, window_ }: { data: MonitoringData; window_: TimeWindow }) {
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
    <div className="space-y-8">
      {/* Prometheus */}
      <section>
        <SectionHeader title="Prometheus" status={promStatus} />
        {data.prometheus.status === 'unavailable' ? (
          <p className="text-sm text-text-tertiary">Not reachable at <span data-private>{data.config.prometheusUrl}</span></p>
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
                      <span className="text-status-error font-medium" data-private>{a.metric.alertname ?? 'Alert'}</span>
                      {a.metric.severity && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-status-error/10 text-status-error">
                          {a.metric.severity}
                        </span>
                      )}
                      {a.metric.instance && (
                        <span className="text-text-tertiary text-xs ml-auto" data-private>{a.metric.instance}</span>
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
                      <span className="font-medium text-text-primary truncate" data-private>{s.metric.job ?? s.metric.instance ?? 'unknown'}</span>
                      {s.metric.instance && s.metric.job && (
                        <span className="text-text-tertiary text-xs ml-auto truncate" data-private>{s.metric.instance}</span>
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
          <p className="text-sm text-text-tertiary">Not reachable at <span data-private>{data.config.lokiUrl}</span></p>
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
