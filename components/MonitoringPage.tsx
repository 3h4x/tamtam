'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'

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

interface Pm2LogEntry {
  ts: string | null
  level: 'error' | 'warn' | 'info'
  line: string
  source: 'error' | 'out'
}

interface Pm2LogData {
  files: Array<{ path: string; size: number | null; mtime: string | null; error?: string }>
  entries: Pm2LogEntry[]
  fetchedAt: number
}

interface SchedulerExpected {
  id: string
  project: string
  name: string
  runner: string
  schedule: string
  expectedName: string
}

interface SchedulerInternalEntry {
  agentId: string
  project: string
  name: string
  schedule: string
  enabled: boolean
  nextFireMs: number
  lastFireMs: number | null
  fireCount: number
  errorCount: number
  lastError: string | null
}

interface SchedulerHealth {
  ok: boolean
  expected: SchedulerExpected[]
  actual: { pm2: string[]; launchctl: string[] }
  missing: SchedulerExpected[]
  orphans: { pm2: string[]; launchctl: string[] }
  errors: string[]
  internal?: { started: boolean; entries: SchedulerInternalEntry[] }
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

function CopyButton({ getText, label, className = '' }: { getText: () => string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-border text-text-tertiary hover:text-text-primary hover:border-text-tertiary bg-transparent cursor-pointer transition-colors ${className}`}
      onClick={async (ev) => {
        ev.stopPropagation()
        try {
          await navigator.clipboard.writeText(getText())
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* ignore */ }
      }}
    >
      {copied ? 'Copied' : label ?? 'Copy'}
    </button>
  )
}

type LogLevelFilter = 'all' | 'warn+' | 'error' | 'warn' | 'info'

const LEVEL_COLORS = {
  error: { text: 'text-status-error', bg: 'bg-status-error/5', border: 'border-l-status-error', badge: 'bg-status-error/15 text-status-error' },
  warn:  { text: 'text-status-warning', bg: 'bg-status-warning/5', border: 'border-l-status-warning', badge: 'bg-status-warning/15 text-status-warning' },
  info:  { text: 'text-text-secondary', bg: '', border: 'border-l-border', badge: 'bg-bg-secondary text-text-tertiary' },
}

function Pm2LogRow({ entry }: { entry: Pm2LogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = entry.line.length > 160
  const display = expanded ? entry.line : entry.line.slice(0, 160)
  const colors = LEVEL_COLORS[entry.level]

  return (
    <div
      className={`group flex gap-0 border-b border-border/30 last:border-b-0 ${isLong ? 'cursor-pointer' : ''} ${colors.bg} hover:bg-bg-secondary/60 transition-colors`}
      onClick={() => isLong && setExpanded(e => !e)}
    >
      <div className={`w-0.5 shrink-0 border-l-2 ${colors.border} self-stretch`} />
      <div className="flex gap-3 px-3 py-1.5 text-xs font-mono min-w-0 flex-1">
        <span className="text-text-tertiary shrink-0 tabular-nums whitespace-nowrap">
          {entry.ts
            ? new Date(entry.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : '—'}
        </span>
        <span className={`${colors.text} shrink-0 font-semibold uppercase w-9`}>{entry.level}</span>
        <span className="text-text-primary break-all whitespace-pre-wrap min-w-0 flex-1" data-private>
          {display}
          {isLong && !expanded && (
            <span className="text-text-tertiary ml-1">…<span className="underline ml-0.5">expand</span></span>
          )}
          {isLong && expanded && (
            <button
              className="ml-2 text-text-tertiary underline hover:text-text-secondary bg-transparent border-none text-xs font-mono cursor-pointer"
              onClick={ev => { ev.stopPropagation(); setExpanded(false) }}
            >collapse</button>
          )}
        </span>
        <CopyButton
          className="opacity-0 group-hover:opacity-100 transition-opacity"
          getText={() => `${entry.ts ?? ''} [${entry.level.toUpperCase()}] ${entry.line}`}
        />
      </div>
    </div>
  )
}

function Pm2LogPanel({ pm2Logs, onRefresh }: { pm2Logs: Pm2LogData | null; onRefresh: () => void }) {
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>('warn+')
  const [hideStdout, setHideStdout] = useState(false)

  // API now returns both error + out logs combined; filter source client-side.
  const allEntries = useMemo(
    () => hideStdout ? (pm2Logs?.entries ?? []).filter(e => e.source === 'error') : (pm2Logs?.entries ?? []),
    [pm2Logs, hideStdout]
  )

  const counts = useMemo(() => ({
    error: allEntries.filter(e => e.level === 'error').length,
    warn:  allEntries.filter(e => e.level === 'warn').length,
    info:  allEntries.filter(e => e.level === 'info').length,
  }), [allEntries])

  const filtered = useMemo(() => {
    if (levelFilter === 'all') return allEntries
    if (levelFilter === 'warn+') return allEntries.filter(e => e.level === 'error' || e.level === 'warn')
    return allEntries.filter(e => e.level === levelFilter)
  }, [allEntries, levelFilter])

  const status: 'ok' | 'unavailable' | 'issue' =
    !pm2Logs ? 'unavailable'
    : counts.error > 0 ? 'issue'
    : 'ok'

  const filterButtons: Array<{ key: LogLevelFilter; label: string; count?: number }> = [
    { key: 'warn+', label: '> Info', count: counts.error + counts.warn },
    { key: 'all', label: 'All', count: allEntries.length },
    { key: 'error', label: 'Error', count: counts.error },
    { key: 'warn', label: 'Warn', count: counts.warn },
    { key: 'info', label: 'Info', count: counts.info },
  ]

  return (
    <section>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <SectionHeader title="tamtam (PM2)" status={status} />
        <div className="flex items-center gap-2 flex-wrap">
          {/* Level filters */}
          {pm2Logs && (
            <div className="flex items-center gap-0.5 rounded-md border border-border overflow-hidden">
              {filterButtons.map(({ key, label, count }) => (
                <button
                  key={key}
                  onClick={() => setLevelFilter(key)}
                  className={`text-[11px] px-2 py-1 border-none cursor-pointer font-medium transition-colors flex items-center gap-1 ${
                    levelFilter === key
                      ? 'bg-bg-secondary text-text-primary'
                      : 'bg-transparent text-text-tertiary hover:text-text-secondary'
                  }`}
                >
                  {label}
                  {count != null && count > 0 && (
                    <span className={`text-[10px] px-1 rounded ${
                      key === 'error' ? LEVEL_COLORS.error.badge
                      : key === 'warn' ? LEVEL_COLORS.warn.badge
                      : LEVEL_COLORS.info.badge
                    }`}>{count}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {/* Stdout toggle */}
          {pm2Logs && (
            <button
              onClick={() => setHideStdout(h => !h)}
              className={`text-[11px] px-2 py-1 rounded border cursor-pointer font-medium transition-colors ${
                hideStdout
                  ? 'border-text-tertiary text-text-primary bg-bg-secondary'
                  : 'border-border text-text-tertiary hover:text-text-secondary bg-transparent'
              }`}
            >
              {hideStdout ? 'errors only' : 'all sources'}
            </button>
          )}
          {/* Refresh + copy */}
          <button
            onClick={onRefresh}
            className="text-[11px] px-2 py-1 rounded border border-border text-text-tertiary hover:text-text-secondary bg-transparent cursor-pointer transition-colors"
          >
            Refresh
          </button>
          {filtered.length > 0 && (
            <CopyButton
              label="Copy all"
              getText={() => filtered.map(e => `${e.ts ?? ''} [${e.level.toUpperCase()}] ${e.line}`).join('\n')}
            />
          )}
        </div>
      </div>

      {!pm2Logs || pm2Logs.files.every(f => f.error) ? (
        <p className="text-sm text-text-tertiary">
          PM2 log file not found at <span data-private>{pm2Logs?.files[0]?.path ?? '~/.pm2/logs/tamtam-error.log'}</span>
        </p>
      ) : (
        <div className="space-y-2">
          {/* File metadata */}
          <div className="flex items-center gap-4 text-xs text-text-tertiary flex-wrap">
            {pm2Logs.files.map((f, i) => (
              <span key={i} data-private className="flex items-center gap-1">
                <span className="font-mono">{f.path.split('/').pop()}</span>
                {f.size != null
                  ? <span className="opacity-70">· {(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  : <span className="text-status-error">{f.error}</span>}
                {f.mtime && <span className="opacity-50">· {new Date(f.mtime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
              </span>
            ))}
            {filtered.length !== allEntries.length && (
              <span className="opacity-60">showing {filtered.length} of {allEntries.length}</span>
            )}
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-text-tertiary">
              {allEntries.length === 0 ? 'No recent log lines' : levelFilter === 'warn+' ? 'No warnings or errors' : `No ${levelFilter} entries`}
            </p>
          ) : (
            <div className="rounded-md border border-border overflow-hidden overflow-y-auto" style={{ maxHeight: '400px' }}>
              {filtered.map((e, i) => <Pm2LogRow key={i} entry={e} />)}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

const WINDOW_LABELS: Record<TimeWindow, string> = { '5m': '5 min', '15m': '15 min', '1h': '1 hour' }

function SchedulerHealthPanel() {
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
    <section>
      <div className="flex items-center justify-between mb-3 gap-2">
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
            <span>launchctl loaded: <span className="text-text-primary font-medium">{health.actual.launchctl.length}</span></span>
            {health.missing.length > 0 && <span className="text-status-error">Missing: {health.missing.length}</span>}
            {(health.orphans.pm2.length + health.orphans.launchctl.length) > 0 && (
              <span className="text-status-warning">Orphans: {health.orphans.pm2.length + health.orphans.launchctl.length}</span>
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

          {(health.orphans.pm2.length + health.orphans.launchctl.length) > 0 && (
            <div>
              <h3 className="text-xs font-medium text-status-warning mb-1">Orphans (loaded but not in DB)</h3>
              <div className="rounded-md border border-status-warning/30 overflow-hidden">
                {health.orphans.pm2.map(n => (
                  <div key={`pm2:${n}`} className="flex items-center gap-3 px-3 py-1.5 text-xs font-mono border-t border-status-warning/20 first:border-t-0">
                    <span className="text-text-tertiary uppercase tracking-wide w-16 shrink-0">pm2</span>
                    <span className="text-text-primary truncate" data-private>{n}</span>
                  </div>
                ))}
                {health.orphans.launchctl.map(l => (
                  <div key={`lc:${l}`} className="flex items-center gap-3 px-3 py-1.5 text-xs font-mono border-t border-status-warning/20 first:border-t-0">
                    <span className="text-text-tertiary uppercase tracking-wide w-16 shrink-0">launchctl</span>
                    <span className="text-text-primary truncate" data-private>{l}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {health.ok && (
            <p className="text-xs text-status-success">All scheduled agents are armed in the internal scheduler / launchctl.</p>
          )}

          {health.internal && health.internal.entries.length > 0 && (
            <SchedulerFireTable entries={health.internal.entries} />
          )}
        </div>
      ) : null}
    </section>
  )
}

function fmtRelative(ms: number | null, now: number): string {
  if (ms === null) return 'never'
  const diff = ms - now
  const abs = Math.abs(diff)
  const sec = Math.round(abs / 1000)
  const min = Math.round(sec / 60)
  const hr = Math.round(min / 60)
  let label: string
  if (sec < 60) label = `${sec}s`
  else if (min < 60) label = `${min}m`
  else if (hr < 48) label = `${hr}h`
  else label = `${Math.round(hr / 24)}d`
  return diff < 0 ? `${label} ago` : `in ${label}`
}

function SchedulerFireTable({ entries }: { entries: SchedulerInternalEntry[] }) {
  const [showAll, setShowAll] = useState(false)
  const now = Date.now()
  const sorted = [...entries].sort((a, b) => {
    if (a.lastError && !b.lastError) return -1
    if (!a.lastError && b.lastError) return 1
    return a.nextFireMs - b.nextFireMs
  })
  const overdue = sorted.filter(e => e.nextFireMs < now)
  const visible = showAll ? sorted : sorted.slice(0, 8)

  return (
    <div>
      <h3 className="text-xs font-medium text-text-secondary mb-1">
        Fire history
        {overdue.length > 0 && (
          <span className="ml-2 text-status-warning">({overdue.length} overdue)</span>
        )}
      </h3>
      <div className="rounded-md border border-border overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-tertiary border-b border-border bg-bg-secondary/30">
          <span>Agent</span>
          <span>Sched</span>
          <span>Next</span>
          <span>Last</span>
          <span>Fires</span>
        </div>
        {visible.map(e => {
          const isOverdue = e.nextFireMs < now
          const hasError = !!e.lastError
          return (
            <div
              key={e.agentId}
              className={`grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-3 py-1.5 text-xs font-mono border-t border-border first:border-t-0 ${hasError ? 'bg-status-error/5' : ''}`}
              title={e.lastError ?? ''}
            >
              <span className="text-text-primary truncate" data-private>{e.project}/{e.name}</span>
              <span className="text-text-tertiary">{e.schedule}</span>
              <span className={isOverdue ? 'text-status-warning' : 'text-text-secondary'}>{fmtRelative(e.nextFireMs, now)}</span>
              <span className={e.lastFireMs === null ? 'text-text-tertiary' : 'text-text-secondary'}>{fmtRelative(e.lastFireMs, now)}</span>
              <span className={e.errorCount > 0 ? 'text-status-error' : 'text-text-secondary'}>
                {e.fireCount}{e.errorCount > 0 ? `/${e.errorCount}!` : ''}
              </span>
            </div>
          )
        })}
      </div>
      {sorted.length > 8 && (
        <button
          onClick={() => setShowAll(v => !v)}
          className="mt-1 text-[11px] text-text-tertiary hover:text-text-secondary cursor-pointer"
        >
          {showAll ? 'Show less' : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  )
}

export function MonitoringPage() {
  const [data, setData] = useState<MonitoringData | null>(null)
  const [pm2Logs, setPm2Logs] = useState<Pm2LogData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [window_, setWindow] = useState<TimeWindow>('15m')

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

      {/* Scheduled agent reconciliation */}
      <SchedulerHealthPanel />

      {/* tamtam PM2 logs */}
      <Pm2LogPanel pm2Logs={pm2Logs} onRefresh={fetchPm2Logs} />

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
