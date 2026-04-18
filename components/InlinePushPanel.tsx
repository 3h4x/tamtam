'use client'

import { useEffect, useState, useRef, type KeyboardEvent } from 'react'
import { fetchPushPreview, generateCommitMessages, executeSmartPush } from '@/lib/client-api'

interface InlinePushPanelProps {
  projectName: string
  onClose: () => void
  onSuccess: () => void
}

type State = 'loading' | 'ready' | 'pushing' | 'done' | 'error'

const STATUS_ICON: Record<string, string> = { M: '~', A: '+', D: '-', R: '→', '?': '+' }
const STATUS_COLOR: Record<string, string> = {
  M: 'text-yellow-600 dark:text-yellow-400',
  A: 'text-green-600 dark:text-green-400',
  D: 'text-red-500',
  R: 'text-blue-500',
  '?': 'text-green-600 dark:text-green-400',
}

export function InlinePushPanel({ projectName, onClose, onSuccess }: InlinePushPanelProps) {
  const [state, setState] = useState<State>('loading')
  const [files, setFiles] = useState<Array<{ status: string; filename: string }>>([])
  const [message, setMessage] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [commitSha, setCommitSha] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  async function regenerate() {
    setState('loading')
    setError(null)
    try {
      const generated = await generateCommitMessages(projectName)
      const opts = generated.options ?? []
      setSuggestions(opts)
      if (opts.length > 0) setMessage(opts[0])
      setState('ready')
      setTimeout(() => textareaRef.current?.focus(), 50)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate')
      setState('error')
    }
  }

  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const [preview, generated] = await Promise.all([
          fetchPushPreview(projectName),
          generateCommitMessages(projectName),
        ])
        if (cancelled) return
        setFiles(preview.files ?? [])
        setSuggestions(generated.options ?? [])
        setMessage(generated.options?.[0] ?? '')
        setState('ready')
        setTimeout(() => textareaRef.current?.focus(), 50)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to prepare push')
        setState('error')
      }
    }
    init()
    return () => { cancelled = true }
  }, [projectName])

  async function handlePush() {
    if (!message.trim()) return
    setState('pushing')
    setError(null)
    try {
      const result = await executeSmartPush(projectName, message.trim())
      setCommitSha(result.commit_sha)
      setState('done')
      setTimeout(() => { onSuccess() }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push failed')
      setState('error')
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (state === 'ready' && message.trim()) handlePush()
    }
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      className="border border-border rounded-lg bg-bg-secondary mt-2 overflow-hidden"
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium text-text-primary">Push changes</span>
        <button
          onClick={onClose}
          className="text-text-tertiary hover:text-text-primary text-lg leading-none cursor-pointer"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {state === 'loading' && (
        <div className="px-3 py-4 text-sm text-text-tertiary">Generating commit message…</div>
      )}

      {state === 'error' && (
        <div className="px-3 py-3 space-y-2">
          <p className="text-sm text-status-error">{error}</p>
          <button onClick={onClose} className="text-xs text-text-secondary hover:text-text-primary">
            Close
          </button>
        </div>
      )}

      {state === 'done' && (
        <div className="px-3 py-4 flex items-center gap-2 text-sm text-status-success">
          <span>✓</span>
          <span>Pushed — {commitSha.slice(0, 8)}</span>
        </div>
      )}

      {(state === 'ready' || state === 'pushing') && (
        <div className="p-3 space-y-3">
          {/* Compact file list */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {files.map((f, i) => {
                const s = f.status?.[0] ?? '?'
                return (
                  <span key={i} className="text-xs font-mono flex items-center gap-1">
                    <span className={STATUS_COLOR[s] ?? 'text-text-tertiary'}>
                      {STATUS_ICON[s] ?? s}
                    </span>
                    <span className="text-text-secondary truncate max-w-[200px]">{f.filename}</span>
                  </span>
                )
              })}
            </div>
          )}

          {/* Commit message */}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={2}
            className="w-full px-2 py-1.5 text-sm font-mono bg-bg-primary border border-border rounded resize-none focus:outline-none focus:ring-1 focus:ring-accent/50 text-text-primary"
            placeholder="Commit message…"
            disabled={state === 'pushing'}
          />

          {/* Alternative suggestions — click to use */}
          {suggestions.length > 1 && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold">Suggestions</span>
                <button
                  onClick={regenerate}
                  disabled={state === 'pushing'}
                  className="text-[10px] text-text-tertiary hover:text-text-primary cursor-pointer bg-transparent border-none"
                  title="Regenerate"
                >↻ regenerate</button>
              </div>
              <div className="flex flex-col gap-1">
                {suggestions.map((opt, i) => {
                  const isActive = opt === message
                  return (
                    <button
                      key={i}
                      onClick={() => setMessage(opt)}
                      disabled={state === 'pushing'}
                      className={`text-left px-2 py-1 text-xs font-mono rounded border cursor-pointer truncate ${
                        isActive
                          ? 'border-accent/50 bg-accent/10 text-text-primary'
                          : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary hover:border-text-tertiary'
                      }`}
                      title={opt}
                    >{opt}</button>
                  )
                })}
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-status-error">{error}</p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={handlePush}
              disabled={!message.trim() || state === 'pushing'}
              className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {state === 'pushing' ? 'Pushing…' : 'Commit & Push'}
            </button>
            <button
              onClick={onClose}
              disabled={state === 'pushing'}
              className="px-3 py-1.5 text-sm border border-border rounded-md text-text-secondary hover:text-text-primary disabled:opacity-50 cursor-pointer"
            >
              Cancel
            </button>
            <span className="text-xs text-text-tertiary ml-auto">⌘↵ to push</span>
          </div>
        </div>
      )}
    </div>
  )
}
