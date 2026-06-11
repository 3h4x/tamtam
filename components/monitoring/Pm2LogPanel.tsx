'use client'

import { useState, useMemo } from 'react'
import { SectionHeader } from './shared'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { SegmentedControl } from '@/components/ui/SegmentedControl'

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

const SOURCE_BADGES = {
  error: 'bg-status-error/15 text-status-error',
  out: 'bg-bg-secondary text-text-tertiary',
} as const

function CopyButton({ getText, label, className = '' }: { getText: () => string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`shrink-0 gap-0 !border-border !bg-transparent px-1.5 py-0.5 text-[10px] font-normal text-text-tertiary hover:!border-text-tertiary hover:!bg-transparent hover:text-text-primary ${className}`}
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
    </Button>
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
        <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold uppercase ${SOURCE_BADGES[entry.source]}`}>
          {entry.source === 'error' ? 'stderr' : 'stdout'}
        </span>
        <span className={`${colors.text} shrink-0 font-semibold uppercase w-9`}>{entry.level}</span>
        <span className="text-text-primary break-all whitespace-pre-wrap min-w-0 flex-1" data-private>
          {display}
          {isLong && !expanded && (
            <span className="text-text-tertiary ml-1">…<span className="underline ml-0.5">expand</span></span>
          )}
          {isLong && expanded && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-2 !border-0 !bg-transparent !px-0 !py-0 align-baseline text-xs font-mono font-normal text-text-tertiary underline hover:!bg-transparent hover:text-text-secondary"
              onClick={ev => { ev.stopPropagation(); setExpanded(false) }}
            >
              collapse
            </Button>
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

export function Pm2LogPanel({
  pm2Logs,
  pm2Error,
  onRefresh,
}: {
  pm2Logs: Pm2LogData | null
  pm2Error: string | null
  onRefresh: () => void
}) {
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>('warn+')
  const [hideStdout, setHideStdout] = useState(false)

  const allEntries = useMemo(
    () => hideStdout ? (pm2Logs?.entries ?? []).filter(e => e.source === 'error') : (pm2Logs?.entries ?? []),
    [pm2Logs, hideStdout]
  )

  const counts = useMemo(() => {
    const next = { error: 0, warn: 0, info: 0 }
    for (const entry of allEntries) next[entry.level] += 1
    return next
  }, [allEntries])

  const filtered = useMemo(() => {
    if (levelFilter === 'all') return allEntries
    if (levelFilter === 'warn+') return allEntries.filter(e => e.level === 'error' || e.level === 'warn')
    return allEntries.filter(e => e.level === levelFilter)
  }, [allEntries, levelFilter])

  const status: 'ok' | 'unavailable' | 'issue' =
    !pm2Logs ? 'unavailable'
    : counts.error > 0 ? 'issue'
    : 'ok'

  // Single-pass partition over pm2Logs.files into error vs available.
  const fileErrors: NonNullable<typeof pm2Logs>['files'] = []
  const availableFiles: NonNullable<typeof pm2Logs>['files'] = []
  for (const file of pm2Logs?.files ?? []) {
    (file.error ? fileErrors : availableFiles).push(file)
  }
  const missingAllFiles = Boolean(pm2Logs) && availableFiles.length === 0

  const filterButtons: Array<{ key: LogLevelFilter; label: string; count?: number }> = [
    { key: 'warn+', label: 'warn+', count: counts.error + counts.warn },
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
            <SegmentedControl<LogLevelFilter>
              ariaLabel="PM2 log level filter"
              size="xs"
              options={filterButtons.map(({ key, label, count }) => ({
                value: key,
                label: (
                  <span className="inline-flex items-center gap-1">
                    {label}
                    {count != null && count > 0 && (
                      <span className={`rounded px-1 text-[10px] ${
                        key === 'error' ? LEVEL_COLORS.error.badge
                        : key === 'warn' ? LEVEL_COLORS.warn.badge
                        : LEVEL_COLORS.info.badge
                      }`}>{count}</span>
                    )}
                  </span>
                ),
              }))}
              value={levelFilter}
              onChange={setLevelFilter}
            />
          )}
          {pm2Logs && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setHideStdout(h => !h)}
              className={`px-2 py-1 text-[11px] ${
                hideStdout
                  ? '!border-text-tertiary !bg-bg-secondary text-text-primary hover:!bg-bg-secondary'
                  : '!border-border !bg-transparent text-text-tertiary hover:!bg-transparent hover:text-text-secondary'
              }`}
            >
              {hideStdout ? 'errors only' : 'all sources'}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            className="!border-border !bg-transparent px-2 py-1 text-[11px] text-text-tertiary hover:!bg-transparent hover:text-text-secondary"
          >
            Refresh
          </Button>
          {filtered.length > 0 && (
            <CopyButton
              label="Copy all"
              getText={() => filtered.map(e => `${e.ts ?? ''} [${e.level.toUpperCase()}] ${e.line}`).join('\n')}
            />
          )}
        </div>
      </div>

      {pm2Error && (
        <ErrorCallout tone="warning" className="text-sm">
          PM2 log refresh failed. Showing last successful results.
          <span className="block text-xs text-text-tertiary">{pm2Error}</span>
        </ErrorCallout>
      )}

      {!pm2Logs ? (
        <EmptyState
          align="start"
          paddingX="none"
          paddingY="none"
          title="PM2 logs are unavailable right now. Refresh to retry after the monitoring API responds."
          className="rounded-lg border border-border bg-bg-secondary px-4 py-3"
        />
      ) : missingAllFiles ? (
        <EmptyState
          align="start"
          paddingX="none"
          paddingY="none"
          title={<span className="text-text-primary">PM2 log files were not found on this host.</span>}
          description={(
            <span className="block space-y-1 text-xs text-text-tertiary">
              {fileErrors.map((file) => (
                <span key={file.path} className="block font-mono" data-private>
                  {file.path}
                </span>
              ))}
            </span>
          )}
          className="rounded-lg border border-border bg-bg-secondary px-4 py-3"
        />
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-4 text-xs text-text-tertiary flex-wrap">
            {availableFiles.map((f) => (
              <span key={f.path} data-private className="flex items-center gap-1">
                <span className="font-mono">{f.path.split('/').pop()}</span>
                {f.size != null
                  ? <span className="opacity-70">· {(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  : f.error
                  ? <span className="text-status-error">· {f.error}</span>
                  : <span className="opacity-70">· size unknown</span>}
                {f.mtime && <span className="opacity-50">· {new Date(f.mtime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
              </span>
            ))}
            {fileErrors.length > 0 && (
              <span className="text-status-warning">
                {fileErrors.length} missing source{fileErrors.length === 1 ? '' : 's'}
              </span>
            )}
            {filtered.length !== allEntries.length && (
              <span className="opacity-60">showing {filtered.length} of {allEntries.length}</span>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              align="start"
              paddingX="none"
              paddingY="none"
              title={allEntries.length === 0
                ? 'No recent PM2 log lines in the available files.'
                : levelFilter === 'warn+'
                ? 'No warnings or errors in the current source selection.'
                : `No ${levelFilter} entries in the current source selection.`}
              className="rounded-lg border border-border bg-bg-secondary px-4 py-3"
            />
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
