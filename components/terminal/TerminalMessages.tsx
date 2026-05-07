'use client'

import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderAnsi, renderAnsiLines, hasAnsi, stripAnsi } from '@/lib/terminal/ansi-render'
import type { TermEntry, ToolEntry, SkillItem } from '@/lib/terminal/terminal-session-store'
import { ToolBlock } from './ToolBlock'

// Collapse carriage-return progress updates (e.g. docker pull) by keeping
// only the content after the last `\r` on each logical line.
function collapseCarriageReturns(text: string): string {
  return text.split('\n').map(line => {
    const idx = line.lastIndexOf('\r')
    return idx >= 0 ? line.slice(idx + 1) : line
  }).join('\n')
}

// CommonMark collapses single newlines into spaces, so prose written with
// hard wraps (Claude often emits short sentences on their own lines) renders
// as one blob. Convert each single `\n` to a Markdown hard-break (`  \n`) so
// the visual line structure survives. Skip content inside fenced code blocks
// — those are pre-formatted and the wrap matters there. Blank-line paragraph
// breaks (`\n\n`) are preserved.
function preserveSingleNewlines(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/([^\n])\n(?!\n)/g, '$1  \n')))
    .join('')
}

interface TerminalMessagesProps {
  history: TermEntry[]
  streaming: boolean
  streamBuffer: string
  thinkingBuffer: string
  rawBuffer: string
  streamTools: ToolEntry[]
  streamIsRaw: boolean
  showThinking: boolean
  messageQueue: string[]
  pendingImageUrls: string[]
  pendingImages: File[]
  elapsedMs: number
  idleSec: number
  spinnerFrame: number
  autoScroll: boolean
  allItems: SkillItem[]
  onScroll: () => void
  onScrollToBottom: () => void
  onToggleItem: (item: SkillItem) => void
  onRemoveImage: (idx: number) => void
  onClearImages: () => void
  onClearQueueItem: (idx: number) => void
  onCancel: () => void
  termRef: React.RefObject<HTMLDivElement | null>
}

const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type LogTone = 'default' | 'info' | 'success' | 'warning' | 'error'
type RawLineKind = 'ambient' | 'meta' | 'command' | 'divider'

const LOG_TONE_STYLES: Record<LogTone, { badge: string; line: string; text: string; block: string }> = {
  default: {
    badge: 'bg-bg-tertiary text-text-tertiary',
    line: 'border-border/30',
    text: 'text-text-secondary',
    block: 'bg-transparent',
  },
  info: {
    badge: 'bg-accent/15 text-accent',
    line: 'border-accent/25',
    text: 'text-text-secondary',
    block: 'bg-accent/[0.04]',
  },
  success: {
    badge: 'bg-status-success/15 text-status-success',
    line: 'border-status-success/25',
    text: 'text-text-secondary',
    block: 'bg-status-success/[0.05]',
  },
  warning: {
    badge: 'bg-status-warning/15 text-status-warning',
    line: 'border-status-warning/25',
    text: 'text-text-secondary',
    block: 'bg-status-warning/[0.06]',
  },
  error: {
    badge: 'bg-status-error/15 text-status-error',
    line: 'border-status-error/25',
    text: 'text-status-error',
    block: 'bg-status-error/[0.07]',
  },
}

function classifyLogLine(text: string, fallback: LogTone = 'default'): LogTone {
  const line = text.trim()
  if (!line) return fallback
  if (/\b(err(?:or)?!?|failed|failure|fatal|panic|exception|traceback|not found|exit [1-9]\d*|do not ship)\b/i.test(line)) return 'error'
  if (/\b(warn(?:ing)?|needs attention|deprecated|retry|timeout|idle)\b/i.test(line)) return 'warning'
  if (/\b(done|passed|success|succeeded|complete(?:d)?|lgtm|ok)\b/i.test(line)) return 'success'
  if (/\b(start(?:ed|ing)?|running|review|testing|pushing|committing|building|loading|fetching)\b/i.test(line)) return 'info'
  return fallback
}

function classifyRawLine(text: string): { kind: RawLineKind; tone: LogTone } {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'ambient', tone: 'default' }
  const tone = classifyLogLine(trimmed)
  if (/^[=-]{3,}$/.test(trimmed) || /^#{2,}\s/.test(trimmed)) return { kind: 'divider', tone: 'info' }
  if ((/^\$ /.test(trimmed) || /^(pnpm|npm|node|git|gh|bash|sh)\b/.test(trimmed)) && tone === 'default') {
    return { kind: 'command', tone: 'info' }
  }
  if (/^\[[^\]]+\]/.test(trimmed) || /^\d{1,2}:\d{2}:\d{2}\b/.test(trimmed)) return { kind: 'meta', tone }
  return { kind: 'ambient', tone }
}

function paneClass(tone: LogTone, variant: 'flat' | 'terminal' = 'flat'): string {
  if (variant === 'terminal') return 'rounded-r-md border-l-2 border-border/60 bg-[#101214] text-text-secondary'
  if (tone === 'error') return 'rounded-r-md border-l-2 border-status-error/60 bg-status-error/[0.06] text-text-secondary'
  if (tone === 'info') return 'rounded-r-md border-l-2 border-accent/30 bg-bg-primary text-text-secondary'
  return 'rounded-r-md border-l-2 border-border/30 bg-transparent text-text-secondary'
}

function RoleBadge({ label, tone = 'default' }: { label: string; tone?: LogTone }) {
  const style = LOG_TONE_STYLES[tone]
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-mono ${style.badge}`}>
      {label}
    </span>
  )
}

function renderLogLineContent(line: string, renderedLine: ReactNode[] | null, className: string) {
  return (
    <span className={className}>
      {renderedLine && renderedLine.length > 0 ? renderedLine : line || ' '}
    </span>
  )
}

function LogBlock({
  text,
  fallbackTone = 'default',
  allowAnsi = false,
  structured = true,
}: {
  text: string
  fallbackTone?: LogTone
  allowAnsi?: boolean
  structured?: boolean
}) {
  const collapsed = collapseCarriageReturns(text)
  const plainLines = collapsed.split('\n')
  const ansiLines = allowAnsi && hasAnsi(collapsed) ? renderAnsiLines(collapsed) : null
  if (!structured) {
    return (
      <div className="space-y-0.5">
        {plainLines.map((line, index) => {
          const plainLine = stripAnsi(line)
          const { kind, tone } = classifyRawLine(plainLine)
          const style = LOG_TONE_STYLES[tone]
          const renderedLine = ansiLines?.[index] ?? null

          if (kind === 'divider') {
            return (
              <div key={`${index}:${line}`} className="flex items-center gap-2 py-1.5">
                <span className="h-px flex-1 bg-border/60" />
                <span className="shrink-0 text-[10px] uppercase tracking-[0.2em] text-text-tertiary/80">
                  {plainLine.replace(/^[#=\-\s]+/, '') || 'section'}
                </span>
                <span className="h-px flex-1 bg-border/60" />
              </div>
            )
          }

          if (kind === 'command') {
            return (
              <div key={`${index}:${line}`} className={`flex items-start gap-2 rounded-r-sm border-l-2 px-2 py-1 ${style.line} ${style.block}`}>
                <span className={`mt-0.5 inline-flex min-w-10 justify-center rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-mono shrink-0 ${style.badge}`}>
                  cmd
                </span>
                {renderLogLineContent(line, renderedLine, 'min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-text-primary')}
              </div>
            )
          }

          if (kind === 'meta' || tone !== 'default') {
            return (
              <div key={`${index}:${line}`} className={`flex items-start gap-2 rounded-r-sm border-l px-2 py-1 ${style.line} ${style.block}`}>
                <span className={`mt-0.5 inline-flex min-w-10 justify-center rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-mono shrink-0 ${style.badge}`}>
                  {tone === 'success' ? 'ok' : tone === 'warning' ? 'warn' : tone === 'error' ? 'err' : kind === 'meta' ? 'meta' : tone}
                </span>
                {renderLogLineContent(line, renderedLine, `min-w-0 flex-1 whitespace-pre-wrap break-words text-xs ${style.text}`)}
              </div>
            )
          }

          return (
            <div key={`${index}:${line}`} className="border-l border-border/25 pl-2">
              {renderLogLineContent(line, renderedLine, 'min-w-0 whitespace-pre-wrap break-words text-xs text-text-secondary')}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {plainLines.map((line, index) => {
        const tone = classifyLogLine(stripAnsi(line), fallbackTone)
        const isAmbient = tone === 'default'
        const style = LOG_TONE_STYLES[tone]
        const renderedLine = ansiLines?.[index] ?? null
        if (isAmbient) {
          return (
            <div key={`${index}:${line}`} className="border-l border-border/25 pl-2">
              {renderLogLineContent(line, renderedLine, 'min-w-0 whitespace-pre-wrap break-words text-text-secondary text-xs')}
            </div>
          )
        }
        return (
          <div key={`${index}:${line}`} className={`flex items-start gap-2 rounded-r-sm border-l-2 px-2 py-1 ${style.line} ${style.block}`}>
            <span className={`mt-0.5 inline-flex min-w-10 justify-center rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-mono shrink-0 ${style.badge}`}>
              {tone === 'success' ? 'ok' : tone === 'warning' ? 'warn' : tone === 'error' ? 'err' : tone}
            </span>
            {renderLogLineContent(line, renderedLine, `min-w-0 flex-1 whitespace-pre-wrap break-words text-xs ${style.text}`)}
          </div>
        )
      })}
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <div className="mx-3 my-1 rounded-r-md border-l-2 border-accent/35 bg-accent/[0.04] px-4 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-accent/60">thinking</div>
      <div className="text-text-tertiary text-xs whitespace-pre-wrap">{text}</div>
    </div>
  )
}

export function TerminalMessages({
  history,
  streaming,
  streamBuffer,
  thinkingBuffer,
  rawBuffer,
  streamTools,
  streamIsRaw,
  showThinking,
  messageQueue,
  pendingImageUrls,
  pendingImages,
  elapsedMs,
  idleSec,
  spinnerFrame,
  autoScroll,
  allItems,
  onScroll,
  onScrollToBottom,
  onToggleItem,
  onRemoveImage,
  onClearImages,
  onClearQueueItem,
  onCancel,
  termRef,
}: TerminalMessagesProps) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  const lastStreamLine = (() => {
    const trimmed = streamBuffer.trimEnd()
    const lastNl = trimmed.lastIndexOf('\n')
    const line = lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1)
    return stripAnsi(line).trim().slice(0, 120) || ''
  })()

  return (
    <>
      {!autoScroll && (
        <button
          className="absolute right-4 bottom-24 z-40 px-2.5 py-1 text-[11px] rounded-full bg-accent/90 text-white hover:bg-accent cursor-pointer border-none font-mono shadow-lg"
          onClick={onScrollToBottom}
          title="Jump to bottom"
        >
          ↓ latest
        </button>
      )}

      {/* Terminal body — scrollable only */}
      <div
        ref={termRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto font-mono text-sm flex flex-col min-h-0"
      >

        {/* Empty state */}
        {history.length === 0 && !streaming && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 select-none py-16">
            <span className="text-3xl font-mono text-border">_</span>
            <span className="text-sm font-mono text-text-tertiary">start a conversation</span>
            <span className="text-[11px] font-mono text-text-tertiary/60">type below · ↵ to send · Shift+↵ newline</span>
            {allItems.length > 0 && (
              <div className="flex flex-col items-center gap-2 mt-3">
                <span className="text-[10px] font-mono text-text-tertiary/40 uppercase tracking-wider">attach a skill</span>
                <div className="flex flex-wrap justify-center gap-1.5 max-w-sm">
                  {allItems.slice(0, 4).map(item => (
                    <button
                      key={item.id}
                      className="text-[11px] px-2 py-1 rounded bg-bg-secondary text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary cursor-pointer border border-border font-mono transition-colors"
                      onClick={() => onToggleItem(item)}
                      title={item.description}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {history.map((entry, i) => (
          entry.role === 'thinking' ? (
            showThinking && <ThinkingBlock key={i} text={entry.text} />
          ) : entry.role === 'tool' && entry.tool ? (
            <ToolBlock key={i} tool={entry.tool} />
          ) : (
          <div key={i}>
            {entry.role === 'user' && i > 0 && (
              <div className="mx-4 my-2 border-t border-border/25" aria-hidden />
            )}
          <div
            className={`group relative mx-3 my-1 px-4 py-2 ${
              entry.role === 'user' ? 'rounded-r-md border-l-2 border-accent/45 bg-accent/[0.03] text-text-primary whitespace-pre-wrap' :
              entry.role === 'error' ? `${paneClass('error')} text-xs` :
              entry.role === 'status' ? `${paneClass('info')} text-xs` :
              entry.role === 'raw' ? `${paneClass('default', 'terminal')} text-xs` :
              `${paneClass('default')} terminal-markdown`
            }`}
          >
            {(entry.role === 'assistant' || entry.role === 'user' || entry.role === 'status' || entry.role === 'error' || entry.role === 'raw') && (
              <div className="mb-1.5">
                <RoleBadge
                  label={entry.role === 'assistant' ? 'agent' : entry.role === 'user' ? 'you' : entry.role === 'error' ? '✗ error' : entry.role}
                  tone={entry.role === 'error' ? 'error' : entry.role === 'status' ? 'info' : entry.role === 'user' ? 'info' : 'default'}
                />
              </div>
            )}
            {entry.role === 'assistant'
              ? (hasAnsi(entry.text)
                  ? <pre className="whitespace-pre-wrap font-mono text-xs m-0">{renderAnsi(entry.text)}</pre>
                  : <Markdown remarkPlugins={[remarkGfm]}>{preserveSingleNewlines(entry.text)}</Markdown>)
              : entry.role === 'raw'
                ? <LogBlock text={entry.text} allowAnsi fallbackTone="default" structured={false} />
              : entry.role === 'status'
                ? <LogBlock text={entry.text} fallbackTone="info" />
              : entry.role === 'error'
                ? <LogBlock text={entry.text} fallbackTone="error" />
              : hasAnsi(entry.text)
                ? <pre className="whitespace-pre-wrap font-mono text-xs m-0 inline">{renderAnsi(entry.text)}</pre>
                : entry.text}
            {entry.imageUrls && entry.imageUrls.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {entry.imageUrls.map((url, j) => (
                  <img key={j} src={url} alt="attachment" className="max-h-40 max-w-[240px] rounded border border-border block" />
                ))}
              </div>
            )}
            {(entry.role === 'assistant' || entry.role === 'user') && entry.text && (
              <button
                className="absolute top-1.5 right-2 p-1 rounded bg-bg-secondary text-text-tertiary hover:text-text-primary border border-border opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                onClick={async (e) => {
                  e.stopPropagation()
                  try {
                    await navigator.clipboard.writeText(entry.text)
                    setCopiedIdx(i)
                    setTimeout(() => setCopiedIdx(prev => prev === i ? null : prev), 1500)
                  } catch { /* ignore */ }
                }}
                title={copiedIdx === i ? 'Copied!' : 'Copy message'}
              >
                {copiedIdx === i ? (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="text-status-success">
                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/>
                    <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/>
                  </svg>
                )}
              </button>
            )}
          </div>
          </div>
          )
        ))}

        {/* Live raw lines from passthrough streaming (test output, section headers, etc.) */}
        {streaming && rawBuffer && (
          <div className={`mx-3 my-1 px-4 py-2 text-xs ${paneClass('default', 'terminal')}`}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <RoleBadge label="raw output" />
              <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-mono">live log</span>
            </div>
            <LogBlock text={rawBuffer} allowAnsi fallbackTone="default" structured={false} />
          </div>
        )}

        {/* Live streamed assistant text */}
        {streaming && streamBuffer && (
          <div className={`mx-3 my-1 px-4 py-2 ${streamIsRaw ? `${paneClass('default', 'terminal')} font-mono text-xs` : `${paneClass('default')} terminal-markdown`}`}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <RoleBadge label={streamIsRaw ? 'raw' : 'agent'} tone={streamIsRaw ? 'default' : 'info'} />
              <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-mono">
                {streamIsRaw ? 'passthrough' : 'streaming'}
              </span>
            </div>
            {streamIsRaw
              ? <LogBlock text={streamBuffer} allowAnsi fallbackTone="default" structured={false} />
              : hasAnsi(streamBuffer)
                ? <pre className="whitespace-pre-wrap font-mono text-xs m-0">{renderAnsi(streamBuffer)}</pre>
                : <Markdown remarkPlugins={[remarkGfm]}>{preserveSingleNewlines(streamBuffer)}</Markdown>}
          </div>
        )}

        {streaming && showThinking && thinkingBuffer && (
          <ThinkingBlock text={thinkingBuffer} />
        )}

        {streaming && streamTools.length > 0 && (() => {
          const lastToolIdx = streamTools.length - 1
          const lastToolExecuting = !streamTools[lastToolIdx].result
          return streamTools.map((tool, i) => (
            <ToolBlock key={`stream-tool-${i}`} tool={tool} executing={i === lastToolIdx && lastToolExecuting} />
          ))
        })()}

        {streaming && (() => {
          const pendingTool = streamTools.length > 0 && !streamTools[streamTools.length - 1].result
            ? streamTools[streamTools.length - 1]
            : null
          let pendingToolContext = ''
          if (pendingTool) {
            try {
              const inp = JSON.parse(pendingTool.input || '{}')
              const ctx = inp.file_path || inp.command || inp.pattern || inp.query || inp.url || inp.path || ''
              if (ctx) {
                const short = ctx.replace(/\s*\n\s*/g, ' ').trim().slice(0, 60)
                pendingToolContext = short ? ` · ${short}` : ''
              }
            } catch { /* ignore */ }
          }
          const label = pendingTool
            ? `${pendingTool.name}${pendingToolContext}…`
            : (lastStreamLine || 'thinking…')
          const isIdle = idleSec >= 5
          const isVeryIdle = idleSec >= 10
          const idleLabel = isIdle ? ` · idle ${idleSec}s` : ''
          return (
            <div className="mx-3 mt-1 rounded-r-md border-l-2 border-accent/30 bg-accent/[0.03] px-4 py-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <RoleBadge label="live run" tone={isIdle ? 'warning' : 'info'} />
                  <span className={`text-[10px] uppercase tracking-wider font-mono ${isIdle ? 'text-status-warning' : 'text-text-tertiary'}`}>
                    {isIdle ? 'waiting for output' : 'receiving output'}
                  </span>
                </div>
                <button
                  className="shrink-0 rounded bg-status-error/20 px-1.5 py-0.5 text-[10px] text-status-error hover:bg-status-error/40 cursor-pointer border-none font-mono leading-none"
                  onClick={onCancel}
                  title="Cancel execution"
                >
                  cancel
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
                {isVeryIdle && (
                  <span className="absolute inset-0 rounded-full bg-status-warning/20 animate-pulse" style={{ animationDuration: '2s' }} />
                )}
                <span className="text-accent font-mono text-sm relative z-10">{spinnerChars[spinnerFrame % spinnerChars.length]}</span>
              </span>
              <span className={`text-xs font-mono shrink-0 tabular-nums ${isIdle ? 'text-status-warning' : 'text-text-tertiary'}`}>{(elapsedMs / 1000).toFixed(1)}s</span>
              <span className={`text-xs font-mono truncate flex-1 ${pendingTool ? 'text-status-warning' : isIdle ? 'text-status-warning/80' : 'text-text-tertiary'}`}>
                {label}{idleLabel}
              </span>
              </div>
            </div>
          )
        })()}

        {messageQueue.length > 0 && (
          <div className="px-4 pb-1">
            {messageQueue.map((msg, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-text-tertiary font-mono py-0.5">
                <span className="text-text-tertiary/60">{i + 1}.</span>
                <span className="truncate flex-1">{msg}</span>
                <button
                  className="text-text-tertiary/60 hover:text-text-secondary cursor-pointer border-none bg-transparent font-mono shrink-0"
                  onClick={() => onClearQueueItem(i)}
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {!streaming && pendingImageUrls.length > 0 && (
          <div className="mx-4 mt-2 px-3 py-2 bg-bg-primary border border-border rounded-md">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-text-tertiary uppercase tracking-wider font-mono">
                {pendingImageUrls.length} attachment{pendingImageUrls.length === 1 ? '' : 's'}
              </span>
              <button
                className="text-[10px] text-text-tertiary hover:text-text-secondary font-mono cursor-pointer border-none bg-transparent"
                onClick={onClearImages}
                title="Remove all attachments"
              >clear all</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {pendingImageUrls.map((url, i) => {
                const f = pendingImages[i]
                const sizeKb = f ? Math.max(1, Math.round(f.size / 1024)) : null
                return (
                  <div key={i} className="relative group">
                    <a href={url} target="_blank" rel="noopener noreferrer" title="open full-size">
                      <img src={url} alt={f?.name ?? 'pending'} className="max-h-24 max-w-[200px] rounded border border-border block" />
                    </a>
                    <button
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-bg-tertiary hover:bg-status-error text-text-secondary hover:text-white text-[11px] leading-none flex items-center justify-center cursor-pointer border border-border shadow"
                      onClick={(e) => { e.stopPropagation(); onRemoveImage(i) }}
                      title="Remove"
                    >×</button>
                    {f && (
                      <div className="mt-1 text-[10px] text-text-tertiary font-mono max-w-[200px] truncate" title={f.name}>
                        {f.name} · {sizeKb}kb
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </div>{/* end scrollable terminal body */}
    </>
  )
}
