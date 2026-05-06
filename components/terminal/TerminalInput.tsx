'use client'

import React from 'react'

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}M`
}

interface LastStats {
  duration: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
}

interface TerminalInputProps {
  input: string
  streaming: boolean
  claudeSessionId: string | null
  currentJobId: string | null
  lastStats: LastStats | null
  messageQueue: string[]
  promptHistory: string[]
  historyIdx: number | null
  draftBeforeHistory: string
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  onInputChange: (value: string) => void
  onHistoryIdxChange: (idx: number | null) => void
  onSaveDraftBeforeHistory: (draft: string) => void
  onSubmit: () => void
  onCancel: () => void
  onClearQueue: () => void
  onPaste: (e: React.ClipboardEvent) => void
}

export function TerminalInput({
  input,
  streaming,
  claudeSessionId,
  currentJobId,
  lastStats,
  messageQueue,
  promptHistory,
  historyIdx,
  draftBeforeHistory,
  inputRef,
  onInputChange,
  onHistoryIdxChange,
  onSaveDraftBeforeHistory,
  onSubmit,
  onCancel,
  onClearQueue,
  onPaste,
}: TerminalInputProps) {
  return (
    <>
      {/* Input row — pinned below the scrollable body */}
      <div className="border-t border-border flex items-start px-4 py-2 bg-bg-primary shrink-0">
          <span className={`shrink-0 mr-1 mt-0.5 ${streaming ? 'text-text-tertiary' : 'text-accent'}`}>{streaming ? '>' : '#'}</span>
          <textarea
            ref={inputRef}
            rows={1}
            className="flex-1 bg-transparent border-none outline-none text-text-primary font-mono text-sm placeholder:text-text-tertiary/40 resize-none overflow-y-auto leading-relaxed"
            style={{ maxHeight: '200px' }}
            value={input}
            onChange={(e) => {
              const v = e.target.value
              onInputChange(v)
              if (historyIdx !== null && v !== promptHistory[historyIdx]) {
                onHistoryIdxChange(null)
              }
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onSubmit()
                if (inputRef.current) inputRef.current.style.height = 'auto'
              } else if (e.key === 'Escape') {
                if (streaming) {
                  e.preventDefault()
                  onCancel()
                } else if (input) {
                  e.preventDefault()
                  onInputChange('')
                  if (inputRef.current) inputRef.current.style.height = 'auto'
                }
              } else if (e.key === 'ArrowUp' && promptHistory.length > 0) {
                const el = inputRef.current
                const beforeCaret = el ? el.value.slice(0, el.selectionStart) : ''
                const onFirstLine = !beforeCaret.includes('\n')
                if (!onFirstLine) return
                e.preventDefault()
                if (historyIdx === null) onSaveDraftBeforeHistory(input)
                const nextIdx = historyIdx === null ? 0 : Math.min(historyIdx + 1, promptHistory.length - 1)
                onHistoryIdxChange(nextIdx)
                onInputChange(promptHistory[nextIdx])
                requestAnimationFrame(() => {
                  const el2 = inputRef.current
                  if (el2) {
                    el2.style.height = 'auto'
                    el2.style.height = `${Math.min(el2.scrollHeight, 200)}px`
                    el2.setSelectionRange(el2.value.length, el2.value.length)
                  }
                })
              } else if (e.key === 'ArrowDown' && historyIdx !== null) {
                const el = inputRef.current
                const afterCaret = el ? el.value.slice(el.selectionStart) : ''
                const onLastLine = !afterCaret.includes('\n')
                if (!onLastLine) return
                e.preventDefault()
                if (historyIdx === 0) {
                  onHistoryIdxChange(null)
                  onInputChange(draftBeforeHistory)
                } else {
                  const nextIdx = historyIdx - 1
                  onHistoryIdxChange(nextIdx)
                  onInputChange(promptHistory[nextIdx])
                }
                requestAnimationFrame(() => {
                  const el2 = inputRef.current
                  if (el2) {
                    el2.style.height = 'auto'
                    el2.style.height = `${Math.min(el2.scrollHeight, 200)}px`
                    el2.setSelectionRange(el2.value.length, el2.value.length)
                  }
                })
              }
            }}
            onPaste={onPaste}
            placeholder={streaming ? 'queue a message... (Esc cancels)' : claudeSessionId ? 'follow-up... (↑/↓ history, Shift+Enter newline)' : 'type a message... (↑/↓ history, Shift+Enter newline)'}
            autoFocus
          />
          {messageQueue.length > 0 && (
            <div className="flex items-center gap-1 ml-2 shrink-0 mt-0.5">
              <span className="text-xs text-text-tertiary font-mono">{messageQueue.length} queued</span>
              <button
                className="text-xs text-text-tertiary hover:text-text-secondary cursor-pointer border-none bg-transparent font-mono"
                onClick={onClearQueue}
                title="Clear queue"
              >✕</button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-1.5 border-t border-border shrink-0 text-xs text-text-tertiary font-mono bg-bg-primary">
          {claudeSessionId ? (
            <>
              <span className="text-text-tertiary">session</span>
              <span className="text-text-secondary">{claudeSessionId.slice(0, 8)}…</span>
              {currentJobId && streaming && (
                <>
                  <span className="text-text-tertiary/30">•</span>
                  <span className="text-status-warning">streaming</span>
                </>
              )}
            </>
          ) : (
            <span>no session</span>
          )}
          {lastStats && (
            <>
              <span className="text-text-tertiary/30">•</span>
              <span className="text-text-secondary" title="Duration">{(lastStats.duration / 1000).toFixed(1)}s</span>
              <span className="text-text-secondary" title="Input / output tokens">
                <span className="text-status-success">↑{fmtTokens(lastStats.inputTokens)}</span>
                {' '}
                <span className="text-accent">↓{fmtTokens(lastStats.outputTokens)}</span>
              </span>
              {(lastStats.cacheReadTokens > 0 || lastStats.cacheCreateTokens > 0) && (
                <span className="text-text-tertiary" title="Cache read / create tokens">
                  cache {fmtTokens(lastStats.cacheReadTokens)}r
                  {lastStats.cacheCreateTokens > 0 ? ` / ${fmtTokens(lastStats.cacheCreateTokens)}w` : ''}
                </span>
              )}
            </>
          )}
        </div>
    </>
  )
}
