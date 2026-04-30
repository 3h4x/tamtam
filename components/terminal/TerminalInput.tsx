'use client'

import React from 'react'

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
      <div className={`border-t flex items-start px-4 py-2 ${streaming ? 'border-[#1e1e1e]' : 'border-[#252525]'} bg-[#0e0e0e] shrink-0`}>
          <span className={`shrink-0 mr-1 mt-0.5 ${streaming ? 'text-[#555]' : 'text-accent'}`}>{streaming ? '>' : '#'}</span>
          <textarea
            ref={inputRef}
            rows={1}
            className="flex-1 bg-transparent border-none outline-none text-[#e0e0e0] font-mono text-sm placeholder:text-[#444] resize-none overflow-y-auto leading-relaxed"
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
              <span className="text-[10px] text-[#555] font-mono">{messageQueue.length} queued</span>
              <button
                className="text-[10px] text-[#555] hover:text-[#888] cursor-pointer border-none bg-transparent font-mono"
                onClick={onClearQueue}
                title="Clear queue"
              >✕</button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-1.5 border-t border-[#1a1a1a] shrink-0 text-[10px] text-[#444] font-mono bg-[#0e0e0e]">
          {claudeSessionId ? (
            <>
              <span className="text-[#555]">session</span>
              <span className="text-[#666]">{claudeSessionId.slice(0, 16)}…</span>
              {currentJobId && streaming && (
                <>
                  <span className="text-[#333]">•</span>
                  <span className="text-status-warning">streaming</span>
                </>
              )}
            </>
          ) : (
            <span>no session</span>
          )}
          {lastStats && (
            <>
              <span className="text-[#333]">•</span>
              <span className="text-[#666]" title="Duration">{(lastStats.duration / 1000).toFixed(1)}s</span>
              <span className="text-[#666]" title="Input / output tokens">
                <span className="text-status-success">↑{lastStats.inputTokens}</span>
                {' / '}
                <span className="text-accent">↓{lastStats.outputTokens}</span>
              </span>
              {(lastStats.cacheReadTokens > 0 || lastStats.cacheCreateTokens > 0) && (
                <span className="text-[#555]" title="Cache read / create tokens">
                  cache {lastStats.cacheReadTokens}r
                  {lastStats.cacheCreateTokens > 0 ? ` / ${lastStats.cacheCreateTokens}w` : ''}
                </span>
              )}
            </>
          )}
        </div>
    </>
  )
}
