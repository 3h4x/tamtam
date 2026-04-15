'use client'

import { useState, useEffect, useRef } from 'react'
import {
  fetchPushPreview,
  generateCommitMessages,
  executeSmartPush,
} from '@/lib/client-api'
import type { PushFile } from '@/lib/client-api'

type PushStep = 'preview' | 'generate' | 'select' | 'execute' | 'done' | 'error'

interface SmartPushModalProps {
  projectName: string
  onClose: () => void
  onSuccess: () => void
}

const STATUS_ICON: Record<string, string> = {
  M: '\u{1F504}',  // modified
  A: '\u{2705}',   // added
  D: '\u{274C}',   // deleted
  R: '\u{1F4C1}',  // renamed
}

const STATUS_COLOR: Record<string, string> = {
  M: 'text-status-warning',
  A: 'text-status-success',
  D: 'text-status-error',
  R: 'text-status-info',
}

const COMMIT_EMOJI: Record<string, string> = {
  'feat:': '\u{2728}',
  'fix:': '\u{1F41B}',
  'refactor:': '\u{267B}\u{FE0F}',
  'docs:': '\u{1F4DD}',
  'chore:': '\u{1F527}',
  'style:': '\u{1F484}',
  'test:': '\u{1F9EA}',
  'ci:': '\u{1F477}',
  'build:': '\u{1F4E6}',
}

function getCommitEmoji(msg: string): string {
  for (const [prefix, emoji] of Object.entries(COMMIT_EMOJI)) {
    if (msg.startsWith(prefix)) return emoji
  }
  return '\u{1F4C4}'
}

export function SmartPushModal({ projectName, onClose, onSuccess }: SmartPushModalProps) {
  const [step, setStep] = useState<PushStep>('preview')
  const [files, setFiles] = useState<PushFile[]>([])
  const [summary, setSummary] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [customMessage, setCustomMessage] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [commitSha, setCommitSha] = useState('')
  const backdropRef = useRef<HTMLDivElement>(null)

  // Load preview on mount
  useEffect(() => {
    let active = true
    setLoading(true)
    fetchPushPreview(projectName)
      .then((data) => {
        if (!active) return
        setFiles(data.files)
        setSummary(data.summary)
        setLoading(false)
      })
      .catch((err) => {
        if (!active) return
        setError(err.message)
        setStep('error')
        setLoading(false)
      })
    return () => { active = false }
  }, [projectName])

  // Escape key to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step !== 'execute') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [step, onClose])

  const handleGenerate = async () => {
    setStep('generate')
    setLoading(true)
    setError(null)
    try {
      const data = await generateCommitMessages(projectName)
      setModel(data.model)
      if (data.options.length > 0) {
        setOptions(data.options)
        setSelected(0)
        setStep('select')
      } else {
        setError(data.error || 'No commit messages generated')
        setUseCustom(true)
        setStep('select')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
      setUseCustom(true)
      setStep('select')
    } finally {
      setLoading(false)
    }
  }

  const handleExecute = async () => {
    const message = useCustom ? customMessage.trim() : (selected !== null ? options[selected] : '')
    if (!message) return

    setStep('execute')
    setLoading(true)
    setError(null)
    try {
      const result = await executeSmartPush(projectName, message)
      setCommitSha(result.commit_sha)
      setStep('done')
      setTimeout(() => onSuccess(), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push failed')
      setStep('error')
    } finally {
      setLoading(false)
    }
  }

  const selectedMessage = useCustom ? customMessage.trim() : (selected !== null ? options[selected] : '')

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === backdropRef.current && step !== 'execute') onClose()
      }}
    >
      <div className="bg-bg-primary border border-border rounded-lg shadow-xl w-[90%] max-w-[600px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="m-0 text-base font-semibold">Push {projectName}</h3>
          {step !== 'execute' && (
            <button
              className="bg-transparent border-none text-xl cursor-pointer text-text-secondary p-0 leading-none"
              onClick={onClose}
            >
              &times;
            </button>
          )}
        </div>

        <div className="p-4 overflow-y-auto">
          {/* PREVIEW STEP */}
          {step === 'preview' && (
            loading ? (
              <div className="flex items-center gap-3 py-6 justify-center text-text-secondary text-sm">
                <div className="spinner" />
                <span>Loading changes...</span>
              </div>
            ) : files.length === 0 ? (
              <div className="text-center py-6">
                <p>No changes to push.</p>
                <button className="action-btn" onClick={onClose}>Close</button>
              </div>
            ) : (
              <>
                <div className="mb-3">
                  {files.map((f) => (
                    <div key={f.filename} className="flex items-center gap-2 py-1 text-sm font-mono">
                      <span
                        className={`w-6 text-center shrink-0 ${STATUS_COLOR[f.status] || 'text-text-secondary'}`}
                      >
                        {STATUS_ICON[f.status] || f.status}
                      </span>
                      <span className="flex-1 text-text-primary overflow-hidden text-ellipsis whitespace-nowrap">
                        {f.filename}
                      </span>
                      <span className="text-text-secondary shrink-0 text-xs">{f.stats}</span>
                    </div>
                  ))}
                </div>
                {summary && (
                  <div className="text-xs text-text-secondary py-2 border-t border-border mb-3">
                    {summary}
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-3 border-t border-border">
                  <button className="action-btn" onClick={onClose}>Cancel</button>
                  <button className="action-btn action-btn--primary" onClick={handleGenerate}>
                    Generate Commit Messages
                  </button>
                </div>
              </>
            )
          )}

          {/* GENERATE STEP */}
          {step === 'generate' && (
            <div className="flex items-center gap-3 py-6 justify-center text-text-secondary text-sm">
              <div className="spinner" />
              <span>Generating commit messages with {model || '...'}...</span>
            </div>
          )}

          {/* SELECT STEP */}
          {step === 'select' && (
            <>
              {error && !useCustom && (
                <div className="bg-status-warning/10 border border-status-warning rounded-sm px-3 py-2 mb-3 text-sm text-status-warning">
                  {error}
                </div>
              )}
              {options.length > 0 && (
                <div className="flex flex-col gap-2 mb-2">
                  {options.map((opt, i) => (
                    <label
                      key={i}
                      className={`flex items-center gap-2 px-3 py-2 border rounded-sm cursor-pointer transition-all text-sm ${
                        !useCustom && selected === i
                          ? 'border-accent bg-accent-light'
                          : 'border-border hover:bg-bg-secondary'
                      }`}
                    >
                      <input
                        type="radio"
                        name="commit"
                        checked={!useCustom && selected === i}
                        onChange={() => { setSelected(i); setUseCustom(false) }}
                        className="hidden"
                      />
                      <span className="shrink-0 text-base">{getCommitEmoji(opt)}</span>
                      <span className="text-text-primary">{opt}</span>
                    </label>
                  ))}
                </div>
              )}
              <label
                className={`flex items-center gap-2 px-3 py-2 border rounded-sm cursor-pointer transition-all text-sm mb-3 ${
                  useCustom
                    ? 'border-accent bg-accent-light'
                    : 'border-border hover:bg-bg-secondary'
                }`}
              >
                <input
                  type="radio"
                  name="commit"
                  checked={useCustom}
                  onChange={() => setUseCustom(true)}
                  className="hidden"
                />
                <span className="shrink-0 text-base">{'\u{270F}\u{FE0F}'}</span>
                <input
                  type="text"
                  className="flex-1 bg-transparent border-none outline-none text-text-primary text-sm font-mono placeholder:text-text-tertiary"
                  placeholder="Write custom message..."
                  value={customMessage}
                  onChange={(e) => { setCustomMessage(e.target.value); setUseCustom(true) }}
                  onFocus={() => setUseCustom(true)}
                />
              </label>
              <div className="flex justify-end gap-2 pt-3 border-t border-border">
                <button className="action-btn" onClick={() => { setStep('preview'); setError(null) }}>
                  Back
                </button>
                <button
                  className="action-btn action-btn--primary"
                  onClick={handleExecute}
                  disabled={!selectedMessage}
                >
                  Commit & Push
                </button>
              </div>
            </>
          )}

          {/* EXECUTE STEP */}
          {step === 'execute' && (
            <div className="flex items-center gap-3 py-6 justify-center text-text-secondary text-sm">
              <div className="spinner" />
              <span>Committing and pushing...</span>
            </div>
          )}

          {/* DONE STEP */}
          {step === 'done' && (
            <div className="text-center py-6">
              <span className="text-[32px] block mb-2">{'\u{2705}'}</span>
              <p>Pushed successfully!</p>
              {commitSha && (
                <code className="bg-bg-secondary px-2 py-1 rounded-sm text-sm text-text-secondary">
                  {commitSha}
                </code>
              )}
            </div>
          )}

          {/* ERROR STEP */}
          {step === 'error' && (
            <div className="text-center py-6">
              <p className="text-status-error">{error}</p>
              <div className="flex justify-end gap-2 pt-3 border-t border-border">
                <button className="action-btn" onClick={onClose}>Close</button>
                <button
                  className="action-btn"
                  onClick={() => { setStep('preview'); setError(null) }}
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
