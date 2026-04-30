'use client'

import { useState, useMemo } from 'react'
import { SectionHeader } from './shared'

export interface Pm2LogEntry {
  ts: string | null
  level: 'error' | 'warn' | 'info'
  line: string
  source: 'error' | 'out'
}

export interface Pm2LogData {
  files: Array<{ path: string; size: number | null; mtime: string | null; error?: string }>
  entries: Pm2LogEntry[]
  fetchedAt: number
}

type LogLevelFilter = 'all' | 'warn+' | 'error' | 'warn' | 'info'

const LEVEL_COLORS = {
  error: { text: 'text-status-error', bg: 'bg-status-error/5', border: 'border-l-status-error', badge: 'bg-status-error/15 text-status-error' },
  warn:  { text: 'text-status-warning', bg: 'bg-status-warning/5', border: 'border-l-status-warning', badge: 'bg-status-warning/15 text-status-warning' },
  info:  { text: 'text-text-secondary', bg: '', border: 'border-l-border', badge: 'bg-bg-secondary text-text-tertiary' },
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

export function Pm2LogPanel({ pm2Logs, onRefresh }: { pm2Logs: Pm2LogData | null; onRefresh: () => void }) {
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>('warn+')
  const [hideStdout, setHideStdout] = useState(false)

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
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <SectionHeader title="tamtam (PM2)" status={status} />
        <div className="flex items-center gap-2 flex-wrap">
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
            <div className="rounded-md border border-border overflow-hidden overflow-y-auto" style={{ maxHeight: '500px' }}>
              {filtered.map((e, i) => <Pm2LogRow key={i} entry={e} />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
