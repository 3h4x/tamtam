'use client'

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { fetchSkills, fetchPersonas } from '@/lib/client-api'
import type { Skill, Persona } from '@/lib/client-api'
import {
  terminalStore,
  type SkillItem,
  type DocItem,
} from '@/lib/terminal/terminal-session-store'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { SessionsPanel } from '@/components/terminal/SessionsPanel'
import { TerminalMessages } from '@/components/terminal/TerminalMessages'
import { TerminalInput } from '@/components/terminal/TerminalInput'
import { TerminalToolbar } from '@/components/terminal/TerminalToolbar'
import { useSessionManager } from '@/components/terminal/useSessionManager'
import { useHandleSubmit } from '@/components/terminal/useHandleSubmit'
import { useTerminalBootstrap } from '@/components/terminal/useTerminalBootstrap'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { MODEL_TIERS, normalizeModelInput, type ModelTier } from '@/lib/agents/model-aliases'
import { type CliProvider } from '@/lib/usage/cli-providers'
import { readBrowserStorageJson, writeBrowserStorage } from '@/lib/client/browser-storage'

// Exported for unit testing — determines whether a job kind uses Claude's
// stream-json output format (parsed path) vs raw log output.
// Notably EXCLUDES `release`: the release log is an aggregation of child logs
// (plain test output + NDJSON review + plain commit/push), so stream-json
// parsing would silently drop every non-NDJSON line. Render it raw so the
// user sees the full aggregated pipeline output.
export function isClaudeJobKind(kind: string | undefined): boolean {
  return ['run', 'review', 'fix', 'fix-ci'].includes(kind ?? '') ||
    (typeof kind === 'string' && kind.startsWith('agent:'))
}

// Decides whether the pending-auto-submit effect should actually fire.
// Extracted so React's StrictMode double-invoke in dev doesn't spawn two
// identical run jobs — the effect consults this via a ref that remembers the
// last text already submitted, and only submits when all three conditions
// hold: not currently streaming, something is pending, and that pending text
// hasn't already been consumed.
export function shouldFireAutoSubmit(
  streaming: boolean,
  pendingAutoSubmit: string | null | undefined,
  alreadyFired: string | null,
): boolean {
  if (streaming) return false
  if (!pendingAutoSubmit) return false
  if (alreadyFired === pendingAutoSubmit) return false
  return true
}

interface TerminalTabProps {
  projectName: string
  initialSessionId?: string
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|heic|heif|avif)$/i

export function TerminalTab({ projectName, initialSessionId }: TerminalTabProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobParam = searchParams.get('job')

  // Large prompts (e.g. issue bodies) are stashed in sessionStorage to avoid
  // tripping Node's 8KB URL/header limit. The query string carries only a
  // short `pending` key. Read once on first render and clear, so reloads
  // don't re-fire the same auto-submit.
  const pendingKey = searchParams.get('pending')
  const [stashed] = useState<{ prompt?: string; issue_number?: string; issue_repo?: string; issue_title?: string; resume_session_id?: string; resume_provider?: string }>(() => {
    if (!pendingKey || typeof window === 'undefined') return {}
    try {
      const raw = sessionStorage.getItem(pendingKey)
      if (!raw) return {}
      sessionStorage.removeItem(pendingKey)
      return JSON.parse(raw)
    } catch { return {} }
  })
  const promptParam = stashed.prompt ?? searchParams.get('prompt')
  const issueNumberParam = stashed.issue_number ?? searchParams.get('issue_number')
  const issueRepoParam = stashed.issue_repo ?? searchParams.get('issue_repo')
  const issueTitleParam = stashed.issue_title ?? searchParams.get('issue_title')
  const resumeSessionIdParam = stashed.resume_session_id ?? null
  const resumeProviderParam = stashed.resume_provider ?? null

  // Subscribe to the module-level session store. Survives component unmounts.
  const state = useSyncExternalStore(
    (l) => terminalStore.subscribe(projectName, l),
    () => terminalStore.get(projectName),
    () => terminalStore.get(projectName),
  )
  const {
    history,
    streamBuffer,
    thinkingBuffer,
    rawBuffer,
    streamTools,
    streaming,
    streamIsRaw,
    streamStartedAt,
    claudeSessionId,
    currentJobId,
    lastStats,
    messageQueue,
    selectedItems,
    selectedDocs,
    pendingAutoSubmit,
    lastError,
  } = state

  const setSelectedItems = (v: SkillItem[] | ((prev: SkillItem[]) => SkillItem[])) =>
    terminalStore.update(projectName, (s) => ({
      selectedItems: typeof v === 'function' ? (v as (p: SkillItem[]) => SkillItem[])(s.selectedItems) : v,
    }))
  const setSelectedDocs = (v: DocItem[] | ((prev: DocItem[]) => DocItem[])) =>
    terminalStore.update(projectName, (s) => ({
      selectedDocs: typeof v === 'function' ? (v as (p: DocItem[]) => DocItem[])(s.selectedDocs) : v,
    }))
  const setMessageQueue = (v: string[] | ((prev: string[]) => string[])) =>
    terminalStore.update(projectName, (s) => ({
      messageQueue: typeof v === 'function' ? (v as (p: string[]) => string[])(s.messageQueue) : v,
    }))

  // Purely local UI state
  const [input, setInput] = useState('')
  const [model, setModel] = useState<ModelTier>('fast')
  const [selectedProvider, setSelectedProvider] = useState<CliProvider | null>(null)
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const [showThinking, setShowThinking] = useState(false)
  const [pendingImages, setPendingImages] = useState<File[]>([])
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const { sessions, loadingSessions, loadSessions, restoreSession: restoreSessionBase } = useSessionManager(projectName)
  const restoreSession = useCallback(async (session: Parameters<typeof restoreSessionBase>[0]) => {
    setShowSessions(false)
    await restoreSessionBase(session)
  }, [restoreSessionBase])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const [promptHistory, setPromptHistory] = useState<string[]>(() => {
    return readBrowserStorageJson<string[]>('tamtam-prompt-history', [])
  })
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)
  const draftBeforeHistoryRef = useRef<string>('')
  // Issue context captured from URL params — only used on the first submission of a new session
  const issueContextRef = useRef<{ number: number; repo: string; title: string } | null>(
    issueNumberParam ? { number: Number(issueNumberParam), repo: issueRepoParam ?? '', title: issueTitleParam ?? '' } : null
  )
  const [autoScroll, setAutoScroll] = useState(true)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [idleSec, setIdleSec] = useState(0)
  const lastActivityRef = useRef<number>(Date.now())

  // What is *actually* running right now. The LIVE RUN block in
  // TerminalMessages renders the kind / provider / model from here so a
  // user landing on the page sees more than a spinner + "receiving output".
  const [runMeta, setRunMeta] = useState<{
    kind: string
    provider: string | null
    model: string | null
    agentName: string | null
    releaseId: string | null
  } | null>(null)
  useEffect(() => {
    if (!streaming || !currentJobId) { setRunMeta(null); return }
    setRunMeta(null)
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}`)
        if (!r.ok) {
          if (!cancelled) setRunMeta(null)
          return
        }
        const d = await r.json()
        if (cancelled) return
        let agentName: string | null = null
        if (typeof d.context_meta === 'string' && d.context_meta) {
          try {
            const meta = JSON.parse(d.context_meta) as { agent?: { name?: string } }
            agentName = meta?.agent?.name ?? null
          } catch { /* ignore malformed meta */ }
        }
        setRunMeta({
          kind: d.kind ?? '',
          provider: d.provider ?? null,
          model: d.model ?? null,
          agentName,
          releaseId: d.release_id ?? null,
        })
      } catch {
        if (!cancelled) setRunMeta(null)
      }
    })()
    return () => { cancelled = true }
  }, [streaming, currentJobId])

  // Skills catalog
  const [allItems, setAllItems] = useState<SkillItem[]>([])
  const [skillSearch, setSkillSearch] = useState('')
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [skillUsage, setSkillUsage] = useState<Record<string, number>>(() => {
    return readBrowserStorageJson<Record<string, number>>('tamtam-skill-usage', {})
  })

  // Docs catalog
  const [allDocs, setAllDocs] = useState<DocItem[]>([])
  const [showDocsPicker, setShowDocsPicker] = useState(false)
  const [docsSearch, setDocsSearch] = useState('')

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        const m = data.settings?.default_model
        if (m && MODEL_TIERS.includes(normalizeModelInput(m, 'fast') as ModelTier)) {
          setModel(normalizeModelInput(m, 'fast') as ModelTier)
        }
      })
      .catch(() => {})
  }, [])

  const { currentReleaseId: bootstrapReleaseId } = useTerminalBootstrap({
    projectName,
    initialSessionId,
    jobParam,
    promptParam,
    issueNumberParam,
    issueTitleParam,
    resumeSessionIdParam,
    resumeProviderParam,
    onLoadSessions: loadSessions,
  })

  // Track the job ID while streaming so we can look it up after completion.
  const lastJobIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (streaming && currentJobId) lastJobIdRef.current = currentJobId
  }, [streaming, currentJobId])

  // After streaming ends, poll briefly for a release job triggered by release_after_run.
  const prevStreamingRef = useRef(false)
  const [postRunReleaseId, setPostRunReleaseId] = useState<string | null>(null)
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current
    prevStreamingRef.current = streaming
    if (streaming) {
      setPostRunReleaseId(null)
      return
    }
    if (!wasStreaming) return
    const lastJobId = lastJobIdRef.current
    if (!lastJobId) return
    let cancelled = false
    const poll = async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (cancelled) return
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000))
        try {
          // Looking for a release row that was spawned from this run. Narrow
          // to release-kind rows; the latest dozen is plenty since this poll
          // runs immediately after a chat finishes.
          const res = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}&kind=release&limit=12`)
          if (!res.ok) continue
          const data = await res.json()
          const found = (data.jobs ?? []).find(
            (j: { kind: string; parent_job_id?: string | null; id: string }) =>
              j.parent_job_id === lastJobId
          )
          if (found) { setPostRunReleaseId(found.id); return }
        } catch {}
      }
    }
    poll()
    return () => { cancelled = true }
  }, [streaming, projectName])

  const currentReleaseId = bootstrapReleaseId ?? postRunReleaseId

  useEffect(() => {
    Promise.all([fetchSkills(), fetchPersonas()]).then(([skillsData, personasData]) => {
      const items: SkillItem[] = [
        ...skillsData.skills.map((s: Skill) => ({ id: s.id, name: s.name, description: s.description, content: s.content, source: 'db' as const })),
        ...personasData.personas.map((p: Persona) => ({ id: `persona:${p.path}`, name: `${p.emoji ? p.emoji + ' ' : ''}${p.name}`, description: `${p.category}${p.description ? ' — ' + p.description : ''}`, source: 'file' as const })),
      ]
      setAllItems(items)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (showDocsPicker && allDocs.length === 0) {
      fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/docs`)
        .then(r => r.json())
        .then(data => setAllDocs(data.docs ?? []))
        .catch(() => {})
    }
  }, [showDocsPicker, projectName, allDocs.length])

  const filteredItems = (() => {
    const q = skillSearch.toLowerCase()
    const matchesSearch = (item: SkillItem) =>
      !q ||
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q)
    const isSelected = (item: SkillItem) => selectedItems.some(sel => sel.id === item.id)
    const selected = allItems.filter(i => isSelected(i) && matchesSearch(i))
    const rest = allItems
      .filter(i => !isSelected(i) && matchesSearch(i))
      .sort((a, b) => (skillUsage[b.id] || 0) - (skillUsage[a.id] || 0))
    return [...selected, ...rest]
  })()

  const toggleItem = (item: SkillItem) => {
    if (selectedItems.some(s => s.id === item.id)) {
      setSelectedItems(prev => prev.filter(s => s.id !== item.id))
      // keep picker open so the user can see the deselection and pick another
    } else {
      setSelectedItems(prev => [...prev, item])
      setSkillSearch('')
      setShowSkillPicker(false)
      setSkillUsage(prev => {
        const updated = { ...prev, [item.id]: (prev[item.id] || 0) + 1 }
        writeBrowserStorage('tamtam-skill-usage', JSON.stringify(updated))
        return updated
      })
    }
  }

  const filteredDocs = allDocs.filter(doc =>
    !selectedDocs.some(d => d.name === doc.name) &&
    (docsSearch === '' || doc.name.toLowerCase().includes(docsSearch.toLowerCase()))
  )

  const toggleDoc = (doc: DocItem) => {
    if (selectedDocs.some(d => d.name === doc.name)) {
      setSelectedDocs(prev => prev.filter(d => d.name !== doc.name))
    } else {
      setSelectedDocs(prev => [...prev, doc])
      setDocsSearch('')
      setShowDocsPicker(false)
    }
  }

  // Spinner animation during streaming.
  const documentVisible = useDocumentVisible()
  useEffect(() => {
    if (!streaming || !documentVisible) return
    const id = setInterval(() => setSpinnerFrame(f => f + 1), 80)
    return () => clearInterval(id)
  }, [streaming, documentVisible])

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [history, streamBuffer, autoScroll])

  const handleScroll = () => {
    if (!termRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = termRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }

  const scrollToBottom = () => {
    if (!termRef.current) return
    termRef.current.scrollTop = termRef.current.scrollHeight
    setAutoScroll(true)
  }

  // Live elapsed timer during streaming
  useEffect(() => {
    if (!streaming || !streamStartedAt) {
      setElapsedMs(0)
      return
    }
    setElapsedMs(Date.now() - streamStartedAt)
    if (!documentVisible) return
    const id = setInterval(() => {
      setElapsedMs(Date.now() - streamStartedAt)
    }, 100)
    return () => clearInterval(id)
  }, [streaming, streamStartedAt, documentVisible])

  // Track last stream activity for idle display
  useEffect(() => {
    lastActivityRef.current = Date.now()
    setIdleSec(0)
  }, [streamBuffer, rawBuffer, streamTools.length, history.length])

  useEffect(() => {
    if (!streaming || !documentVisible) return
    const id = setInterval(() => {
      setIdleSec(Math.floor((Date.now() - lastActivityRef.current) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [streaming, documentVisible])

  const addImages = useCallback((files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/') || IMG_EXT.test(f.name))
    if (!imageFiles.length) return
    setPendingImages(prev => [...prev, ...imageFiles])
    imageFiles.forEach(file => {
      const reader = new FileReader()
      reader.onload = (e) => {
        setPendingImageUrls(prev => [...prev, e.target?.result as string])
      }
      reader.readAsDataURL(file)
    })
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!termRef.current?.contains(e.relatedTarget as Node)) setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      addImages(files)
      return
    }
    const itemFiles: File[] = []
    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) itemFiles.push(f)
      }
    }
    if (itemFiles.length > 0) addImages(itemFiles)
  }, [addImages])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    if (files.some(f => f.type.startsWith('image/'))) {
      e.preventDefault()
      addImages(files)
    }
  }, [addImages])

  const { handleSubmit } = useHandleSubmit({
    projectName, streaming, input, pendingImages, pendingImageUrls,
    selectedItems, selectedDocs, model, selectedProvider, issueContextRef, draftBeforeHistoryRef,
    setInput, setPendingImages, setPendingImageUrls, setPromptHistory,
    setHistoryIdx, setMessageQueue,
  })

  // Auto-submit dequeued message after streaming ends.
  const autoSubmittedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!shouldFireAutoSubmit(streaming, pendingAutoSubmit, autoSubmittedRef.current)) return
    autoSubmittedRef.current = pendingAutoSubmit
    const text = pendingAutoSubmit!
    terminalStore.clearPendingAutoSubmit(projectName)
    handleSubmit(text)
  }, [streaming, pendingAutoSubmit])

  const handleNewSession = () => {
    terminalStore.reset(projectName)
    router.replace(`/project/${projectName}/terminal`)
    inputRef.current?.focus()
  }

  const handleCancel = async () => {
    const jobId = terminalStore.cancelStream(projectName)
    if (!jobId) return
    try {
      await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
    } catch {}
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  // Resume the most recent user prompt against the existing session. Used by
  // the error banner; safe to call regardless of `lastError.kind` (manual
  // resume is the user's explicit decision, so it bypasses the auto-retry
  // budget tracked on `lastError.autoRetryUsed`).
  const handleResume = useCallback(() => {
    const lastUserText = [...history].reverse().find((e) => e.role === 'user')?.text ?? ''
    if (!lastUserText) return
    terminalStore.update(projectName, () => ({ lastError: null }))
    handleSubmit(lastUserText)
  }, [history, projectName, handleSubmit])

  const handleDismissError = useCallback(() => {
    terminalStore.update(projectName, () => ({ lastError: null }))
  }, [projectName])

  const [showCloseStale, setShowCloseStale] = useState(false)
  const [closeStaleFindings, setCloseStaleFindings] = useState('')
  const [closeStaleReason, setCloseStaleReason] = useState<'stale' | 'duplicate' | 'wontfix' | 'fixed'>('stale')
  const [closingStale, setClosingStale] = useState(false)
  const handleCloseStale = async () => {
    const issue = issueContextRef.current
    if (!issue || !issue.number || !closeStaleFindings.trim()) return
    setClosingStale(true)
    try {
      const r = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/issues/${issue.number}/close-stale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findings: closeStaleFindings.trim(), reason: closeStaleReason }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        alert(`Close failed: ${data.detail ?? r.statusText}`)
        return
      }
      setShowCloseStale(false)
      setCloseStaleFindings('')
      issueContextRef.current = null
    } finally {
      setClosingStale(false)
    }
  }

  return (
    <div
      className="mt-4 flex flex-col"
      style={{ height: 'calc(100vh - 280px)', minHeight: '400px' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`flex-1 bg-bg-primary rounded-lg border ${dragOver ? 'border-accent' : 'border-border'} flex flex-col overflow-hidden relative`}>
        {dragOver && (
          <div className="absolute inset-0 bg-accent/10 z-50 flex items-center justify-center pointer-events-none rounded-lg">
            <span className="text-accent text-sm font-mono">drop image</span>
          </div>
        )}

        {/* Issue actions banner — visible when this session is linked to a GitHub issue */}
        {issueContextRef.current?.number ? (
          <div className="px-3 py-2 border-b border-border bg-bg-secondary text-xs flex items-center gap-2 flex-wrap">
            <span className="text-text-secondary">
              Issue #{issueContextRef.current.number}
              {issueContextRef.current.title ? ` — ${issueContextRef.current.title}` : ''}
            </span>
            {!showCloseStale ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setShowCloseStale(true)}
                className="ml-auto px-2 py-1 rounded border border-border bg-bg-tertiary text-text-secondary hover:text-text-primary"
                title="Close this issue with a verdict comment"
              >
                Close with verdict
              </Button>
            ) : (
              <div className="ml-auto flex items-start gap-2 w-full mt-2">
                <Select
                  surface="tertiary"
                  size="compact"
                  value={closeStaleReason}
                  onChange={(e) => setCloseStaleReason(e.target.value as typeof closeStaleReason)}
                >
                  <option value="stale">stale</option>
                  <option value="duplicate">duplicate</option>
                  <option value="wontfix">wontfix</option>
                  <option value="fixed">fixed</option>
                </Select>
                <textarea
                  value={closeStaleFindings}
                  onChange={(e) => setCloseStaleFindings(e.target.value)}
                  placeholder="Findings to post as a comment before closing…"
                  rows={3}
                  className="flex-1 px-2 py-1 rounded border border-border bg-bg-tertiary text-text-primary text-xs font-mono"
                />
                <div className="flex flex-col gap-1">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!closeStaleFindings.trim() || closingStale}
                    onClick={handleCloseStale}
                    className="px-2 py-1 rounded border border-border bg-accent/20 text-text-primary disabled:opacity-50"
                  >
                    {closingStale ? 'closing…' : 'Comment + Close'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => { setShowCloseStale(false); setCloseStaleFindings('') }}
                    className="px-2 py-1 rounded border border-border bg-bg-tertiary text-text-secondary"
                  >
                    cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* Terminal header */}
        <TerminalToolbar
          projectName={projectName}
          streaming={streaming}
          showSessions={showSessions}
          sessions={sessions}
          currentReleaseId={currentReleaseId}
          showThinking={showThinking}
          selectedItems={selectedItems}
          selectedDocs={selectedDocs}
          allItems={allItems}
          allDocs={allDocs}
          skillSearch={skillSearch}
          showSkillPicker={showSkillPicker}
          skillUsage={skillUsage}
          docsSearch={docsSearch}
          showDocsPicker={showDocsPicker}
          model={model}
          provider={claudeSessionId && state.sessionProvider ? (state.sessionProvider as CliProvider) : selectedProvider}
          providerLocked={!!(claudeSessionId && state.sessionProvider)}
          filteredItems={filteredItems}
          filteredDocs={filteredDocs}
          onNewSession={handleNewSession}
          onToggleSessions={() => { if (!showSessions) loadSessions(); setShowSessions(s => !s) }}
          onToggleThinking={() => setShowThinking(s => !s)}
          onToggleItem={toggleItem}
          onToggleDoc={toggleDoc}
          onSkillSearchChange={setSkillSearch}
          onToggleSkillPicker={() => setShowSkillPicker(s => !s)}
          onDocsSearchChange={setDocsSearch}
          onToggleDocsPicker={() => setShowDocsPicker(s => !s)}
          onModelChange={setModel}
          onProviderChange={setSelectedProvider}
        />

        {/* Sessions panel */}
        {showSessions && (
          <SessionsPanel
            sessions={sessions}
            loadingSessions={loadingSessions}
            onRestore={restoreSession}
          />
        )}

        <TerminalMessages
          history={history}
          streaming={streaming}
          streamBuffer={streamBuffer}
          thinkingBuffer={thinkingBuffer}
          rawBuffer={rawBuffer}
          streamTools={streamTools}
          streamIsRaw={streamIsRaw}
          showThinking={showThinking}
          messageQueue={messageQueue}
          pendingImageUrls={pendingImageUrls}
          pendingImages={pendingImages}
          elapsedMs={elapsedMs}
          idleSec={idleSec}
          spinnerFrame={spinnerFrame}
          runMeta={runMeta}
          autoScroll={autoScroll}
          allItems={allItems}
          onScroll={handleScroll}
          onScrollToBottom={scrollToBottom}
          onToggleItem={toggleItem}
          onRemoveImage={(idx) => {
            setPendingImages(prev => prev.filter((_, i) => i !== idx))
            setPendingImageUrls(prev => prev.filter((_, i) => i !== idx))
          }}
          onClearImages={() => { setPendingImages([]); setPendingImageUrls([]) }}
          onClearQueueItem={(idx) => setMessageQueue(prev => prev.filter((_, j) => j !== idx))}
          onCancel={handleCancel}
          termRef={termRef}
          lastError={lastError}
          onResume={handleResume}
          onDismissError={handleDismissError}
        />

        <TerminalInput
          input={input}
          streaming={streaming}
          claudeSessionId={claudeSessionId}
          currentJobId={currentJobId}
          lastStats={lastStats}
          messageQueue={messageQueue}
          promptHistory={promptHistory}
          historyIdx={historyIdx}
          draftBeforeHistory={draftBeforeHistoryRef.current}
          inputRef={inputRef}
          onInputChange={setInput}
          onHistoryIdxChange={setHistoryIdx}
          onSaveDraftBeforeHistory={(draft) => { draftBeforeHistoryRef.current = draft }}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onClearQueue={() => setMessageQueue([])}
          onPaste={handlePaste}
        />
      </div>
    </div>
  )
}
