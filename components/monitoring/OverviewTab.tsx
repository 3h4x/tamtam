'use client'

import type { MonitoringData, TimeWindow } from './types'
import { WINDOW_LABELS } from './types'
import type { Pm2LogData } from './Pm2LogPanel'

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${ok ? 'bg-status-success' : 'bg-status-error'}`} />
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatNightlyCleanupLine(data: MonitoringData['retention']['lastNightlyCleanup']): string {
  if (!data) return 'No nightly cleanup recorded'
  const base = `${data.status} · ${data.rowsDeleted} rows`
  const error = data.lastError ? ` · ${data.lastError}` : ''
  return `${base}${error}`
}

function formatProjectLogCleanupLine(data: MonitoringData['retention']['lastProjectLogCleanup']): string {
  if (!data) return 'No project log prune recorded'
  const base = `${data.status} · ${data.logFilesDeleted} files, ${formatBytes(data.bytesReclaimed)}`
  return data.lastError ? `${base} · ${data.lastError}` : base
}

function getRetentionStatus(retention: MonitoringData['retention']): 'ok' | 'issue' | 'unavailable' {
  const nightlyCleanup = retention.lastNightlyCleanup
  const projectLogCleanup = retention.lastProjectLogCleanup

  if (!nightlyCleanup && !projectLogCleanup) return 'unavailable'
  if (nightlyCleanup?.status === 'failed') return 'issue'
  if (projectLogCleanup?.status === 'failed') return 'issue'
  return 'ok'
}

export function OverviewTab({
  data,
  pm2Logs,
  window_,
}: {
  data: MonitoringData
  pm2Logs: Pm2LogData | null
  window_: TimeWindow
}) {
  const downServices = data.prometheus.services.filter(s => s.value?.[1] === '0')
  const upServices = data.prometheus.services.filter(s => s.value?.[1] !== '0')
  const pm2ErrorCount = pm2Logs?.entries.filter(e => e.level === 'error').length ?? 0
  const pm2WarnCount  = pm2Logs?.entries.filter(e => e.level === 'warn').length ?? 0
  const throttle = data.notificationThrottle
  const retention = data.retention
  const nightlyCleanup = retention.lastNightlyCleanup
  const projectLogCleanup = retention.lastProjectLogCleanup
  const nightlyCleanupTime = nightlyCleanup
    ? new Date(nightlyCleanup.finishedAt * 1000).toLocaleString()
    : null
  const nightlyCleanupTouched = formatNightlyCleanupLine(nightlyCleanup)
  const projectLogCleanupTouched = formatProjectLogCleanupLine(projectLogCleanup)
  const cleanupStatus = getRetentionStatus(retention)

  const sections = [
    {
      title: 'tamtam (PM2)',
      status: !pm2Logs ? 'unavailable' : pm2ErrorCount > 0 ? 'issue' : 'ok',
      lines: [
        pm2ErrorCount > 0 ? `${pm2ErrorCount} error${pm2ErrorCount > 1 ? 's' : ''}` : null,
        pm2WarnCount  > 0 ? `${pm2WarnCount} warning${pm2WarnCount > 1 ? 's' : ''}` : null,
        pm2ErrorCount === 0 && pm2WarnCount === 0 ? 'No warnings or errors' : null,
      ].filter(Boolean) as string[],
    },
    {
      title: 'Prometheus',
      status: data.prometheus.status === 'unavailable' ? 'unavailable'
        : data.prometheus.alerts.length > 0 || downServices.length > 0 ? 'issue' : 'ok',
      lines: [
        data.prometheus.status === 'unavailable' ? 'Not reachable' : null,
        data.prometheus.alerts.length > 0 ? `${data.prometheus.alerts.length} firing alert${data.prometheus.alerts.length > 1 ? 's' : ''}` : null,
        downServices.length > 0 ? `${downServices.length} service${downServices.length > 1 ? 's' : ''} down` : null,
        data.prometheus.status !== 'unavailable' && data.prometheus.alerts.length === 0 && downServices.length === 0
          ? `${upServices.length} service${upServices.length !== 1 ? 's' : ''} up` : null,
      ].filter(Boolean) as string[],
    },
    {
      title: `Loki (last ${WINDOW_LABELS[window_]})`,
      status: data.loki.status === 'unavailable' ? 'unavailable'
        : data.loki.errors.length > 0 ? 'issue' : 'ok',
      lines: [
        data.loki.status === 'unavailable' ? 'Not reachable' : null,
        data.loki.errors.length > 0 ? `${data.loki.errors.length} error${data.loki.errors.length > 1 ? 's' : ''}` : null,
        data.loki.warnings.length > 0 ? `${data.loki.warnings.length} warning${data.loki.warnings.length > 1 ? 's' : ''}` : null,
        data.loki.status !== 'unavailable' && data.loki.errors.length === 0 && data.loki.warnings.length === 0 ? 'No errors or warnings' : null,
      ].filter(Boolean) as string[],
    },
    {
      title: 'Notifications',
      status: 'ok',
      lines: [
        `Throttle window ${throttle.windowSeconds}s`,
        throttle.suppressedTotal > 0
          ? `${throttle.suppressedTotal} suppressed alert${throttle.suppressedTotal === 1 ? '' : 's'} pending`
          : 'No suppressed alerts pending',
      ],
    },
    {
      title: 'Retention',
      status: cleanupStatus,
      lines: [
        `Logs ${retention.policy.logRetentionCount} runs / ${retention.policy.logRetentionDays}d`,
        `Rows ${retention.policy.jobRowRetentionDays}d`,
        nightlyCleanupTime ? `Nightly ${nightlyCleanupTime}` : nightlyCleanupTouched,
        nightlyCleanupTime ? nightlyCleanupTouched : null,
        projectLogCleanupTouched,
      ].filter(Boolean) as string[],
    },
  ] as const

  const statusIcon = (s: string) =>
    s === 'ok' ? '✓' : s === 'issue' ? '!' : '–'
  const statusCls = (s: string) =>
    s === 'ok' ? 'text-status-success bg-status-success/10 border-status-success/20'
    : s === 'issue' ? 'text-status-warning bg-status-warning/10 border-status-warning/20'
    : 'text-text-tertiary bg-bg-secondary border-border'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {sections.map(sec => (
          <div key={sec.title} className={`rounded-lg border p-4 flex flex-col gap-2 ${statusCls(sec.status)}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{sec.title}</span>
              <span className="text-xs font-bold w-5 h-5 rounded-full border flex items-center justify-center shrink-0">
                {statusIcon(sec.status)}
              </span>
            </div>
            <ul className="space-y-0.5">
              {sec.lines.map((l, i) => (
                <li key={i} className="text-xs opacity-80">{l}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {throttle.entries.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-text-secondary mb-2 uppercase tracking-wide">Notification throttle</h3>
          <div className="space-y-1">
            {throttle.entries.map((entry) => (
              <div key={entry.key} className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-bg-secondary text-sm">
                <span className="font-mono text-xs text-text-primary truncate" data-private>{entry.key}</span>
                <span className="ml-auto text-xs text-text-tertiary">{entry.suppressedCount} suppressed</span>
                <span className="text-xs text-text-tertiary">{new Date(entry.lastSentAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Firing alerts inline */}
      {data.prometheus.status !== 'unavailable' && data.prometheus.alerts.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-text-secondary mb-2 uppercase tracking-wide">Firing alerts</h3>
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

      {/* Down services inline */}
      {downServices.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-text-secondary mb-2 uppercase tracking-wide">Down services</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
            {downServices.map((s, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-md border bg-status-error/5 border-status-error/30 text-sm">
                <StatusDot ok={false} />
                <span className="font-medium text-text-primary truncate" data-private>{s.metric.job ?? s.metric.instance ?? 'unknown'}</span>
                {s.metric.instance && s.metric.job && (
                  <span className="text-text-tertiary text-xs ml-auto truncate" data-private>{s.metric.instance}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
