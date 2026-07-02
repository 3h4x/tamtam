'use client'

import { useState, useEffect, useRef, useCallback, useMemo, useReducer, useSyncExternalStore } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  fetchAgents,
  fetchCustomActions,
  fetchIssuesAndPRs,
  fetchProjectDocs,
  fetchSkills,
  fetchPersonas,
  releaseProject,
  runCustomAction,
  testProject,
  fetchSettings,
} from '@/lib/client-api'
import type { Agent, CustomAction, Skill, Persona } from '@/lib/client-api'
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
import { TerminalIssueBanner } from '@/components/terminal/TerminalIssueBanner'
import { MODEL_TIERS, normalizeModelInput, type ModelTier } from '@/lib/agents/model-aliases'
import { normalizePermissionMode, type PermissionMode } from '@/lib/shared/permission-modes'
import { type CliProvider } from '@/lib/usage/cli-providers'
import { readBrowserStorageJson, writeBrowserStorage } from '@/lib/client/browser-storage'
import {
  resolveSlashCommands,
  suggestedPromptsFromIssues,
  type SlashCommand,
  type SuggestedPrompt,
} from '@/lib/terminal/slash-command-palette'

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
const EMPTY_SEARCH_PARAMS = new URLSearchParams()
const BYTES_PER_TOKEN_ESTIMATE = 4

export function TerminalTab({ projectName, initialSessionId }: TerminalTabProps) {
  const router = useRouter()
  const searchParams = useSearchParams() ?? EMPTY_SEARCH_PARAMS
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
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto')
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const [showThinking, setShowThinking] = useState(false)
  const [pendingImages, setPendingImages] = useState<File[]>([])
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  // Land directly in the usable terminal — the recent-sessions panel is opt-in
  // via the toolbar toggle. It used to default open, so every visit forced a
  // "close" click past a list of past runs before you could type.
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
  // When this session is linked to a GitHub issue, resolve the open PR that
  // implements it (branch `fix/issue-N-…` or a `Closes #N` reference) so the
  // issue banner can link straight to the PR, not just name the issue.
  const [issuePr, setIssuePr] = useState<{ number: number; url: string } | null>(null)
  useEffect(() => {
    const ic = issueContextRef.current
    if (!ic?.number) return
    let cancelled = false
    const n = ic.number
    const closes = new RegExp(`\\b(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\\s+#${n}\\b`, 'i')
    fetchIssuesAndPRs(projectName)
      .then(({ prs }) => {
        if (cancelled) return
        const match = prs.find((p) => p.headRefName?.startsWith(`fix/issue-${n}-`) || closes.test(p.body ?? ''))
        if (match) setIssuePr({ number: match.number, url: match.url })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectName, issueNumberParam])
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
  const [customActions, setCustomActions] = useState<CustomAction[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [suggestedPrompts, setSuggestedPrompts] = useState<SuggestedPrompt[]>([])
  const [promptEstimateWarnTokens, setPromptEstimateWarnTokens] = useState(50000)

  useEffect(() => {
    fetchSettings()
      .then((data) => {
        const m = data.settings?.default_model
        if (m && MODEL_TIERS.includes(normalizeModelInput(m, 'fast') as ModelTier)) {
          setModel(normalizeModelInput(m, 'fast') as ModelTier)
        }
        if (data.settings?.permission_mode) {
          setPermissionMode(normalizePermissionMode(String(data.settings.permission_mode)))
        }
        const warnTokens = Number(data.settings?.prompt_estimate_warn_tokens)
        if (Number.isFinite(warnTokens) && warnTokens >= 0) {
          setPromptEstimateWarnTokens(warnTokens)
        }
      })
      .catch(() => {})
  }, [])

  const promptEstimateWarning = useMemo(() => {
    if (promptEstimateWarnTokens <= 0 || claudeSessionId || streaming) return null
    const promptParts = [
      ...selectedItems
        .filter((item) => item.source === 'db' && item.content)
        .map((item) => `## ${item.name}\n${item.content}`),
      ...selectedDocs.map((doc) => `## ${doc.name}\n${doc.content}`),
      input,
    ].filter(Boolean)
    const bytes = new TextEncoder().encode(promptParts.join('\n\n---\n\n')).length
    const estimatedInputTokens = Math.round(bytes / BYTES_PER_TOKEN_ESTIMATE)
    if (estimatedInputTokens < promptEstimateWarnTokens) return null
    return {
      estimatedInputTokens,
      warnTokens: promptEstimateWarnTokens,
    }
  }, [claudeSessionId, input, promptEstimateWarnTokens, selectedDocs, selectedItems, streaming])

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

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

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

  useEffect(() => {
    Promise.all([
      fetchProjectDocs(projectName).catch(() => ({ docs: [] })),
      fetchCustomActions(projectName).catch(() => ({ actions: [] })),
      fetchAgents(projectName, { fields: 'summary' }).catch(() => ({ agents: [] })),
      fetchIssuesAndPRs(projectName).catch(() => ({ issues: [] })),
    ]).then(([docsData, actionsData, agentsData, issuesData]) => {
      setAllDocs(docsData.docs.map((doc) => ({ name: doc.name, content: doc.content })))
      setCustomActions(actionsData.actions)
      setAgents(agentsData.agents)
      setSuggestedPrompts(suggestedPromptsFromIssues(issuesData.issues ?? []))
    }).catch(() => {})
  }, [projectName])

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

  const toggleItem = useCallback((item: SkillItem) => {
    const isSelected = terminalStore.get(projectName).selectedItems.some(s => s.id === item.id)
    if (isSelected) {
      setSelectedItems(prev => prev.filter(s => s.id !== item.id))
      // keep picker open so the user can see the deselection and pick another
    } else {
      setSelectedItems(prev => prev.some(s => s.id === item.id) ? prev : [...prev, item])
      setSkillSearch('')
      setShowSkillPicker(false)
      setSkillUsage(prev => {
        const updated = { ...prev, [item.id]: (prev[item.id] || 0) + 1 }
        writeBrowserStorage('tamtam-skill-usage', JSON.stringify(updated))
        return updated
      })
    }
  }, [projectName])

  const normalizedDocsSearch = docsSearch.toLowerCase()
  const filteredDocs = allDocs.filter(doc =>
    !selectedDocs.some(d => d.name === doc.name) &&
    (normalizedDocsSearch === '' || doc.name.toLowerCase().includes(normalizedDocsSearch))
  )

  const toggleDoc = useCallback((doc: DocItem) => {
    const isSelected = terminalStore.get(projectName).selectedDocs.some(d => d.name === doc.name)
    if (isSelected) {
      setSelectedDocs(prev => prev.filter(d => d.name !== doc.name))
    } else {
      setSelectedDocs(prev => prev.some(d => d.name === doc.name) ? prev : [...prev, doc])
      setDocsSearch('')
      setShowDocsPicker(false)
    }
  }, [projectName])

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

  // A submit that hit a blocking job (release/fix/etc.) is queued server-side
  // rather than rejected. We poll its status and attach the live stream once
  // the queued run starts. Survives navigation only within this mounted tab;
  // the queue row itself is DB-backed, so a refresh re-attaches via history.
  const [queuedRunId, setQueuedRunId] = useState<string | null>(null)
  useEffect(() => {
    if (!queuedRunId) return
    let cancelled = false
    const poll = async () => {
      while (!cancelled) {
        try {
          const res = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/queued-runs/${encodeURIComponent(queuedRunId)}`)
          if (res.ok) {
            const data = await res.json() as { status: string; jobId: string | null }
            if (data.status === 'started' && data.jobId) {
              if (!cancelled) {
                terminalStore.startStream(projectName, data.jobId)
                setQueuedRunId(null)
              }
              return
            }
            if (data.status === 'gone') { if (!cancelled) setQueuedRunId(null); return }
          }
        } catch { /* transient — keep polling */ }
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    poll()
    return () => { cancelled = true }
  }, [queuedRunId, projectName])

  const { handleSubmit } = useHandleSubmit({
    projectName, streaming, input, pendingImages, pendingImageUrls,
    selectedItems, selectedDocs, model, selectedProvider, permissionMode, issueContextRef, draftBeforeHistoryRef,
    setInput, setPendingImages, setPendingImageUrls, setPromptHistory,
    setHistoryIdx, setMessageQueue, onQueued: setQueuedRunId,
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

  const slashQuery = input.startsWith('/') ? input.slice(1).trim() : ''
  const slashCommands = resolveSlashCommands({
    skills: allItems,
    docs: allDocs,
    agents,
    customActions,
  }, slashQuery)

  const replaceComposer = useCallback((text: string) => {
    setInput(text)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(text.length, text.length)
    })
  }, [])

  const appendStatus = useCallback((text: string) => {
    terminalStore.update(projectName, (s) => ({
      history: [...s.history, { role: 'status', text }],
    }))
  }, [projectName])

  const handleSlashCommandSelect = useCallback(async (command: SlashCommand) => {
    if (command.kind === 'skill') {
      const item = allItems.find((candidate) => `skill:${candidate.id}` === command.id)
      if (item) toggleItem(item)
      replaceComposer('')
      return
    }
    if (command.kind === 'doc') {
      const doc = allDocs.find((candidate) => `doc:${candidate.name}` === command.id)
      if (doc) toggleDoc(doc)
      replaceComposer('')
      return
    }
    if (command.kind === 'action') {
      const actionName = command.id.slice('action:'.length)
      replaceComposer('')
      appendStatus(`starting custom action: ${actionName}`)
      try {
        const result = await runCustomAction(projectName, actionName)
        terminalStore.startStream(projectName, result.job_id, false, true)
      } catch (err) {
        terminalStore.update(projectName, (s) => ({
          history: [...s.history, { role: 'error', text: err instanceof Error ? err.message : 'Failed to start action' }],
        }))
      }
      return
    }
    if (command.kind === 'builtin') {
      replaceComposer('')
      if (command.id === 'builtin:clear') {
        handleNewSession()
        return
      }
      if (command.id === 'builtin:test') {
        appendStatus('starting test job')
        try {
          const result = await testProject(projectName)
          terminalStore.startStream(projectName, result.job_id, false, true)
        } catch (err) {
          terminalStore.update(projectName, (s) => ({
            history: [...s.history, { role: 'error', text: err instanceof Error ? err.message : 'Failed to start tests' }],
          }))
        }
        return
      }
      if (command.id === 'builtin:release') {
        appendStatus('starting release pipeline')
        try {
          const result = await releaseProject(projectName)
          const jobId = result.release_job_id ?? result.job_id
          if (jobId) terminalStore.startStream(projectName, jobId, false, true)
        } catch (err) {
          terminalStore.update(projectName, (s) => ({
            history: [...s.history, { role: 'error', text: err instanceof Error ? err.message : 'Failed to start release' }],
          }))
        }
        return
      }
    }
    replaceComposer(command.insertText ?? '')
  }, [allDocs, allItems, appendStatus, projectName, replaceComposer, toggleDoc, toggleItem])

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

  // The issue banner reads `issueContextRef` (a ref, not state); bump this to
  // re-render and drop the banner once the linked issue is closed.
  const [, forceIssueBannerRerender] = useReducer((n: number) => n + 1, 0)

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
          <TerminalIssueBanner
            projectName={projectName}
            issue={issueContextRef.current}
            issuePr={issuePr}
            onClosed={() => { issueContextRef.current = null; setIssuePr(null); forceIssueBannerRerender() }}
          />
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
          permissionMode={permissionMode}
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
          onPermissionModeChange={setPermissionMode}
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
          suggestedPrompts={suggestedPrompts}
          onScroll={handleScroll}
          onScrollToBottom={scrollToBottom}
          onToggleItem={toggleItem}
          onSuggestedPrompt={replaceComposer}
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
          model={model}
          provider={claudeSessionId && state.sessionProvider ? (state.sessionProvider as CliProvider) : selectedProvider}
          selectedSkillCount={selectedItems.length}
          selectedDocCount={selectedDocs.length}
          imageCount={pendingImages.length}
          promptEstimateWarning={promptEstimateWarning}
          slashCommands={slashCommands}
          onSlashCommandSelect={handleSlashCommandSelect}
        />
      </div>
    </div>
  )
}
