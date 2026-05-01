'use client'

import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderAnsi, hasAnsi } from '@/lib/terminal/ansi-render'
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

function ThinkingBlock({ text }: { text: string }) {
  return (
    <div className="px-4 py-2 border-l-2 border-accent/35 ml-4 mr-4 my-1 bg-accent/[0.04] rounded-r">
      <div className="text-[10px] text-accent/60 mb-1 uppercase tracking-wider">thinking</div>
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
    return line.trim().slice(0, 120) || ''
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
            <span className="text-[11px] font-mono text-text-tertiary/60">type below · ⌘↵ to send</span>
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
          <div
            key={i}
            className={`group relative px-4 py-2 ${
              entry.role === 'user' ? 'text-[#f0f0f0] whitespace-pre-wrap border-l-2 border-accent/40' :
              entry.role === 'error' ? 'text-status-error whitespace-pre-wrap border-l-2 border-status-error/60 bg-status-error/8' :
              entry.role === 'status' ? 'text-[#888] whitespace-pre-wrap text-[11px] border-l-2 border-[#333] bg-[#141414]' :
              entry.role === 'raw' ? 'text-[#b0b8b0] font-mono text-xs whitespace-pre-wrap border-l-2 border-[#3a4a3a] bg-[#0e120e]' :
              'text-[#e0e0e0] terminal-markdown'
            }`}
          >
            {entry.role === 'user' && <span className="text-accent mr-2">#</span>}
            {entry.role === 'status' && <span className="text-[#555] mr-2 select-none">›</span>}
            {entry.role === 'error' && <span className="text-status-error mr-2 select-none">!</span>}
            {entry.role === 'assistant'
              ? (hasAnsi(entry.text)
                  ? <pre className="whitespace-pre-wrap font-mono text-xs m-0">{renderAnsi(entry.text)}</pre>
                  : <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>)
              : entry.role === 'raw'
                ? (hasAnsi(entry.text)
                    ? <pre className="whitespace-pre-wrap font-mono text-xs m-0 inline">{renderAnsi(collapseCarriageReturns(entry.text))}</pre>
                    : collapseCarriageReturns(entry.text))
              : hasAnsi(entry.text)
                ? <pre className="whitespace-pre-wrap font-mono text-xs m-0 inline">{renderAnsi(entry.text)}</pre>
                : entry.text}
            {entry.imageUrls && entry.imageUrls.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {entry.imageUrls.map((url, j) => (
                  <img key={j} src={url} alt="attachment" className="max-h-40 max-w-[240px] rounded border border-[#333] block" />
                ))}
              </div>
            )}
            {(entry.role === 'assistant' || entry.role === 'user') && entry.text && (
              <button
                className="absolute top-1.5 right-2 px-1.5 py-0.5 text-[10px] rounded bg-[#1f1f1f] text-[#666] hover:text-[#ccc] border border-[#2a2a2a] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer font-mono"
                onClick={async (e) => {
                  e.stopPropagation()
                  try {
                    await navigator.clipboard.writeText(entry.text)
                    setCopiedIdx(i)
                    setTimeout(() => setCopiedIdx(prev => prev === i ? null : prev), 1500)
                  } catch { /* ignore */ }
                }}
                title="Copy message"
              >
                {copiedIdx === i ? 'copied' : 'copy'}
              </button>
            )}
          </div>
          )
        ))}

        {/* Live raw lines from passthrough streaming (test output, section headers, etc.) */}
        {streaming && rawBuffer && (
          <div className="px-4 py-2 text-[#b0b8b0] font-mono text-xs whitespace-pre-wrap border-l-2 border-[#3a4a3a] bg-[#0e120e]">
            {hasAnsi(rawBuffer)
              ? <pre className="whitespace-pre-wrap font-mono text-xs m-0 inline">{renderAnsi(collapseCarriageReturns(rawBuffer))}</pre>
              : collapseCarriageReturns(rawBuffer)}
          </div>
        )}

        {/* Live streamed assistant text */}
        {streaming && streamBuffer && (
          <div className={`px-4 py-2 ${streamIsRaw ? 'text-[#c0c0c0] font-mono text-xs whitespace-pre-wrap' : 'text-[#e0e0e0] terminal-markdown'}`}>
            {streamIsRaw
              ? (hasAnsi(streamBuffer)
                  ? <pre className="whitespace-pre-wrap font-mono text-xs m-0 inline">{renderAnsi(collapseCarriageReturns(streamBuffer))}</pre>
                  : collapseCarriageReturns(streamBuffer))
              : hasAnsi(streamBuffer)
                ? <pre className="whitespace-pre-wrap font-mono text-xs m-0">{renderAnsi(streamBuffer)}</pre>
                : <Markdown remarkPlugins={[remarkGfm]}>{streamBuffer}</Markdown>}
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
          const idleLabel = isIdle ? ` · idle ${idleSec}s` : ''
          return (
            <div className="px-4 py-2 flex items-center gap-2 border-l-2 border-accent/30 bg-accent/[0.02]">
              <span className="text-accent font-mono text-sm">{spinnerChars[spinnerFrame % spinnerChars.length]}</span>
              <span className={`text-xs font-mono shrink-0 tabular-nums ${isIdle ? 'text-status-warning' : 'text-[#888]'}`}>{(elapsedMs / 1000).toFixed(1)}s</span>
              <span className={`text-xs font-mono truncate flex-1 ${pendingTool ? 'text-status-warning' : isIdle ? 'text-status-warning/80' : 'text-[#888]'}`}>
                {label}{idleLabel}
              </span>
              <button
                className="text-[10px] px-1.5 py-0.5 rounded bg-status-error/20 text-status-error hover:bg-status-error/40 cursor-pointer border-none font-mono leading-none shrink-0"
                onClick={onCancel}
                title="Cancel execution"
              >
                cancel
              </button>
            </div>
          )
        })()}

        {messageQueue.length > 0 && (
          <div className="px-4 pb-1">
            {messageQueue.map((msg, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-[#888] font-mono py-0.5">
                <span className="text-[#666]">{i + 1}.</span>
                <span className="truncate flex-1">{msg}</span>
                <button
                  className="text-[#666] hover:text-[#aaa] cursor-pointer border-none bg-transparent font-mono shrink-0"
                  onClick={() => onClearQueueItem(i)}
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {!streaming && pendingImageUrls.length > 0 && (
          <div className="mx-4 mt-2 px-3 py-2 bg-[#161616] border border-[#2a2a2a] rounded-md">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-[#666] uppercase tracking-wider font-mono">
                {pendingImageUrls.length} attachment{pendingImageUrls.length === 1 ? '' : 's'}
              </span>
              <button
                className="text-[10px] text-[#666] hover:text-[#aaa] font-mono cursor-pointer border-none bg-transparent"
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
                      <img src={url} alt={f?.name ?? 'pending'} className="max-h-24 max-w-[200px] rounded border border-[#333] block" />
                    </a>
                    <button
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#2a2a2a] hover:bg-status-error text-[#ccc] hover:text-white text-[11px] leading-none flex items-center justify-center cursor-pointer border border-[#444] shadow"
                      onClick={(e) => { e.stopPropagation(); onRemoveImage(i) }}
                      title="Remove"
                    >×</button>
                    {f && (
                      <div className="mt-1 text-[10px] text-[#666] font-mono max-w-[200px] truncate" title={f.name}>
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
