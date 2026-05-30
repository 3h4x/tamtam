'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { SectionHeader, StatusDot } from './shared'
import type { MonitoringData, TimeWindow } from './types'
import { WINDOW_LABELS } from './types'

const SUMMARY_TONE_CLASSES = {
  neutral: 'border-border bg-bg-secondary',
  success: 'border-status-success/30 bg-status-success/5',
  warning: 'border-status-warning/30 bg-status-warning/5',
  error: 'border-status-error/30 bg-status-error/5',
} as const

function SummaryCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: number | string
  detail: string
  tone?: 'neutral' | 'success' | 'warning' | 'error'
}) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${SUMMARY_TONE_CLASSES[tone]}`}>
      <p className="text-xs text-text-tertiary">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-text-primary">{value}</p>
      <p className="mt-1 text-xs text-text-secondary">{detail}</p>
    </div>
  )
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <EmptyState
      align="start"
      bordered
      paddingY="xs"
      title={<span className="font-normal text-text-tertiary">{message}</span>}
      className="rounded-lg px-3 py-4"
    />
  )
}

function UnavailablePanel({ endpoint }: { endpoint: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary px-3 py-4 text-sm text-text-tertiary">
      Not reachable at <span className="font-mono text-text-secondary" data-private>{endpoint}</span>
    </div>
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-2 !border-0 !bg-transparent !px-0 !py-0 align-baseline text-xs font-mono font-normal text-text-tertiary underline hover:!bg-transparent hover:text-text-secondary"
            onClick={e => { e.stopPropagation(); setExpanded(false) }}
          >
            collapse
          </Button>
        )}
      </span>
    </div>
  )
}

export function InfraTab({ data, window_ }: { data: MonitoringData; window_: TimeWindow }) {
  // Single-pass partition — previously filtered the same array twice with
  // opposite predicates, allocating two intermediate arrays per render.
  const downServices: typeof data.prometheus.services = []
  const upServices: typeof data.prometheus.services = []
  for (const s of data.prometheus.services) {
    (s.value?.[1] === '0' ? downServices : upServices).push(s)
  }
  const alertCount = data.prometheus.alerts.length
  const errorCount = data.loki.errors.length
  const warningCount = data.loki.warnings.length
  const windowLabel = WINDOW_LABELS[window_]

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
          <UnavailablePanel endpoint={data.config.prometheusUrl} />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              <SummaryCard
                label="firing alerts"
                value={alertCount}
                detail={alertCount > 0 ? 'needs attention now' : 'none'}
                tone={alertCount > 0 ? 'error' : 'success'}
              />
              <SummaryCard
                label="services down"
                value={downServices.length}
                detail={downServices.length > 0 ? 'check failing targets below' : 'all reachable'}
                tone={downServices.length > 0 ? 'error' : 'success'}
              />
              <SummaryCard
                label="services up"
                value={upServices.length}
                detail={data.prometheus.services.length > 0 ? 'reporting healthy targets' : 'no targets reported'}
                tone={upServices.length > 0 ? 'success' : 'neutral'}
              />
            </div>

            {alertCount > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-text-secondary">
                  Active alerts ({alertCount})
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
              <h3 className="mb-2 text-sm font-medium text-text-secondary">
                Service status
              </h3>
              {data.prometheus.services.length === 0 ? (
                <EmptyPanel message="No Prometheus service targets were returned." />
              ) : (
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {[...downServices, ...upServices].map((s, i) => {
                    const up = s.value?.[1] !== '0'
                    return (
                      <div key={i} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                        up ? 'border-border bg-bg-secondary' : 'border-status-error/30 bg-status-error/5'
                      }`}>
                        <StatusDot ok={up} />
                        <span className="truncate font-medium text-text-primary" data-private>{s.metric.job ?? s.metric.instance ?? 'unknown'}</span>
                        {s.metric.instance && s.metric.job && (
                          <span className="ml-auto truncate text-xs text-text-tertiary" data-private>{s.metric.instance}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Loki */}
      <section>
        <SectionHeader title={`Loki — last ${windowLabel}`} status={lokiStatus} />
        {data.loki.status === 'unavailable' ? (
          <UnavailablePanel endpoint={data.config.lokiUrl} />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              <SummaryCard
                label="errors"
                value={errorCount}
                detail={errorCount > 0 ? `seen in the last ${windowLabel}` : `clear for the last ${windowLabel}`}
                tone={errorCount > 0 ? 'error' : 'success'}
              />
              <SummaryCard
                label="warnings"
                value={warningCount}
                detail={warningCount > 0 ? 'review if the count is climbing' : 'none reported'}
                tone={warningCount > 0 ? 'warning' : 'success'}
              />
              <SummaryCard
                label="window"
                value={windowLabel}
                detail="current log scan range"
              />
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-text-secondary">
                Error log lines
              </h3>
              {errorCount === 0 ? (
                <EmptyPanel message={`No error log lines in the last ${windowLabel}.`} />
              ) : (
                <div className="rounded-md border border-status-error/30 overflow-hidden overflow-y-auto" style={{ maxHeight: '320px' }}>
                  {data.loki.errors.map((l, i) => (
                    <LogRow key={i} entry={l} color="error" />
                  ))}
                </div>
              )}
            </div>

            {warningCount > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-text-secondary">
                  Warning log lines ({warningCount})
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
