'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { runProject, fetchPersonas } from '@/lib/client-api'
import type { Persona } from '@/lib/client-api'

interface RunModalProps {
  projectName: string
  onClose: () => void
}

export function RunModal({ projectName, onClose }: RunModalProps) {
  const router = useRouter()
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ job_id: string; pid: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Persona state
  const [personas, setPersonas] = useState<Persona[]>([])
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null)
  const [personaSearch, setPersonaSearch] = useState('')
  const [showPersonaPicker, setShowPersonaPicker] = useState(false)
  const personaSearchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
    fetchPersonas()
      .then(data => setPersonas(data.personas))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (showPersonaPicker) {
      personaSearchRef.current?.focus()
    }
  }, [showPersonaPicker])

  const filteredPersonas = personaSearch
    ? personas.filter(p =>
        p.name.toLowerCase().includes(personaSearch.toLowerCase()) ||
        p.category.toLowerCase().includes(personaSearch.toLowerCase()) ||
        p.description.toLowerCase().includes(personaSearch.toLowerCase())
      )
    : personas

  const handleSubmit = async () => {
    if (!prompt.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await runProject(
        projectName,
        prompt.trim(),
        files.length > 0 ? files : undefined,
        selectedPersona?.path,
      )
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start')
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    setFiles(prev => [...prev, ...Array.from(newFiles)])
  }, [])

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }, [addFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const clipFiles = e.clipboardData.files
    if (clipFiles.length > 0) {
      e.preventDefault()
      addFiles(clipFiles)
    }
  }, [addFiles])

  const isImage = (file: File) => file.type.startsWith('image/')

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-primary border border-border rounded-lg shadow-xl w-[90%] max-w-[700px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="m-0 text-base font-semibold">Run — {projectName}</h3>
          <button
            className="bg-transparent border-none text-xl cursor-pointer text-text-secondary p-0 leading-none"
            onClick={onClose}
          >
            &times;
          </button>
        </div>
        <div className="p-4 overflow-y-auto">
          {result ? (
            <div className="text-center py-6">
              <span className="text-[32px] block mb-2">{'\u{1F680}'}</span>
              <p>Run started</p>
              <div className="flex flex-col gap-2 w-full max-w-[500px] mx-auto mt-3 p-3 bg-surface rounded-md text-sm">
                <div className="flex justify-between items-center gap-3">
                  <span className="shrink-0 text-xs uppercase tracking-wide text-text-tertiary">Project</span>
                  <span>{projectName}</span>
                </div>
                <div className="flex justify-between items-center gap-3">
                  <span className="shrink-0 text-xs uppercase tracking-wide text-text-tertiary">PID</span>
                  <span>{result.pid}</span>
                </div>
                <div className="flex justify-between items-center gap-3">
                  <span className="shrink-0 text-xs uppercase tracking-wide text-text-tertiary">Run ID</span>
                  <span className="text-xs font-mono">{result.job_id}</span>
                </div>
                {selectedPersona && (
                  <div className="flex justify-between items-center gap-3">
                    <span className="shrink-0 text-xs uppercase tracking-wide text-text-tertiary">Persona</span>
                    <span>{selectedPersona.emoji || '\u{1F916}'} {selectedPersona.name}</span>
                  </div>
                )}
                <div className="flex justify-between items-center gap-3">
                  <span className="shrink-0 text-xs uppercase tracking-wide text-text-tertiary">Prompt</span>
                  <span className="text-xs max-w-[400px] overflow-hidden text-ellipsis whitespace-nowrap">{prompt}</span>
                </div>
              </div>
              <div className="flex justify-center gap-2 mt-4">
                <button
                  className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
                  onClick={() => {
                    onClose()
                    router.push(`/project/${projectName}/jobs/${result.job_id}`)
                  }}
                >
                  View logs
                </button>
                <button
                  className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                  onClick={onClose}
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Persona selector */}
              <div className="mb-2">
                {selectedPersona ? (
                  <div className="inline-flex items-center gap-2 px-3 py-1 border border-accent rounded-sm bg-accent-light text-sm">
                    <span>{selectedPersona.emoji || '\u{1F916}'}</span>
                    <span className="font-medium text-text-primary">{selectedPersona.name}</span>
                    <span className="text-text-tertiary text-xs">{selectedPersona.category}</span>
                    <button
                      className="bg-transparent border-none text-text-tertiary cursor-pointer p-0 text-sm leading-none hover:text-status-error"
                      onClick={() => setSelectedPersona(null)}
                      title="Remove persona"
                    >
                      &times;
                    </button>
                  </div>
                ) : (
                  <button
                    className="action-btn text-xs"
                    onClick={() => setShowPersonaPicker(!showPersonaPicker)}
                  >
                    {'\u{1F916}'} Pick persona
                  </button>
                )}
              </div>

              {showPersonaPicker && !selectedPersona && (
                <div className="mb-3 border border-border rounded-sm overflow-hidden">
                  <input
                    ref={personaSearchRef}
                    type="text"
                    className="w-full px-3 py-2 border-none border-b border-border bg-bg-secondary text-text-primary text-sm outline-none placeholder:text-text-tertiary"
                    value={personaSearch}
                    onChange={(e) => setPersonaSearch(e.target.value)}
                    placeholder="Search personas..."
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setShowPersonaPicker(false)
                        setPersonaSearch('')
                      }
                    }}
                  />
                  <div className="max-h-[250px] overflow-y-auto">
                    {filteredPersonas.slice(0, 50).map((p) => (
                      <button
                        key={p.path}
                        className="flex items-center gap-2 w-full px-3 py-2 border-none border-b border-divider bg-transparent text-text-primary cursor-pointer text-left text-sm min-h-0 hover:bg-bg-secondary last:border-b-0"
                        onClick={() => {
                          setSelectedPersona(p)
                          setShowPersonaPicker(false)
                          setPersonaSearch('')
                          textareaRef.current?.focus()
                        }}
                      >
                        <span className="text-base shrink-0 w-6 text-center">{p.emoji || '\u{1F916}'}</span>
                        <div className="flex-1 min-w-0 flex flex-col">
                          <span className="font-medium">{p.name}</span>
                          <span className="text-xs text-text-tertiary overflow-hidden text-ellipsis whitespace-nowrap">
                            {p.description}
                          </span>
                        </div>
                        <span className="text-xs text-text-tertiary shrink-0">{p.category}</span>
                      </button>
                    ))}
                    {filteredPersonas.length === 0 && (
                      <div className="text-text-tertiary p-3 text-center">
                        No matches
                      </div>
                    )}
                    {filteredPersonas.length > 50 && (
                      <div className="text-text-tertiary p-2 text-center text-xs">
                        {filteredPersonas.length - 50} more — refine search
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div
                className={`border-2 border-dashed rounded-sm transition-colors ${
                  dragging
                    ? 'border-accent bg-accent-light'
                    : 'border-transparent'
                }`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                <textarea
                  ref={textareaRef}
                  className="w-full min-h-[120px] p-3 font-mono text-sm leading-relaxed bg-bg-primary text-text-primary border border-border rounded-sm resize-y mb-3 outline-none focus:border-accent placeholder:text-text-tertiary"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder="What should Claude do?"
                  rows={8}
                  disabled={submitting}
                />
              </div>

              {files.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {files.map((file, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1 border border-border rounded-sm text-xs bg-bg-secondary max-w-[200px]">
                      {isImage(file) ? (
                        <img
                          src={URL.createObjectURL(file)}
                          alt={file.name}
                          className="w-8 h-8 object-cover rounded-[2px] shrink-0"
                        />
                      ) : (
                        <span className="text-base shrink-0">{'\u{1F4CE}'}</span>
                      )}
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap text-text-primary" title={file.name}>
                        {file.name}
                      </span>
                      <span className="text-text-tertiary shrink-0">
                        {file.size < 1024 ? `${file.size}B` :
                         file.size < 1048576 ? `${Math.round(file.size / 1024)}KB` :
                         `${(file.size / 1048576).toFixed(1)}MB`}
                      </span>
                      <button
                        className="bg-transparent border-none text-text-tertiary cursor-pointer p-0 text-sm leading-none hover:text-status-error"
                        onClick={() => removeFile(i)}
                        title="Remove"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {error && (
                <div className="text-center py-6">
                  <span className="text-status-error">{error}</span>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-3 border-t border-border">
                <span className="text-text-tertiary text-xs mr-auto flex gap-2 items-center">
                  <button
                    className="px-2 py-0.5 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={submitting}
                  >
                    Attach files
                  </button>
                  &#8984;+Enter to run
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
                <button
                  className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                  onClick={onClose}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
                  onClick={handleSubmit}
                  disabled={!prompt.trim() || submitting}
                >
                  {submitting ? 'Starting...' : 'Run'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
