'use client'

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { runProject, fetchSkills, fetchPersonas } from '@/lib/client-api'
import type { Skill, Persona } from '@/lib/client-api'
import Markdown from 'react-markdown'
import { renderAnsi, hasAnsi } from '@/lib/ansi-render'
import {
  terminalStore,
  type ToolEntry,
  type TermEntry,
  type SkillItem,
  type DocItem,
} from '@/lib/terminal-session-store'

interface SessionItem {
  id: string
  prompt: string | null
  startedAt: number
  finishedAt: number | null
  sessionId: string | null
  exitCode: number | null
}

interface TerminalTabProps {
  projectName: string
  initialSessionId?: string
}

const TOOL_COLORS: Record<string, string> = {
  Bash: 'text-[#f0b070]',
  Read: 'text-[#8fcfff]',
  Edit: 'text-[#c9b4ff]',
  Write: 'text-[#c9b4ff]',
  Glob: 'text-[#8fdfb0]',
  Grep: 'text-[#8fdfb0]',
  Task: 'text-[#ffb0c0]',
  WebFetch: 'text-[#ffd080]',
  WebSearch: 'text-[#ffd080]',
}

function ToolBlock({ tool }: { tool: ToolEntry }) {
  const [collapsed, setCollapsed] = useState(true)

  let summary = ''
  try {
    const input = JSON.parse(tool.input || '{}')
    summary = input.file_path || input.command || input.pattern || input.query || ''
  } catch {
    summary = tool.input?.slice(0, 60) || ''
  }

  const hasResult = !!tool.result
  const resultPreview = tool.result
    ? tool.result.length > 600 ? tool.result.slice(0, 600) + '...' : tool.result
    : null

  const nameColor = TOOL_COLORS[tool.name] ?? 'text-[#9cc7ff]'
  const clickable = hasResult

  return (
    <div className="mx-4 group/tool">
      <div
        className={`flex items-baseline gap-2 px-2 py-0.5 rounded-sm leading-tight ${clickable ? 'cursor-pointer hover:bg-[#181818]' : ''}`}
        onClick={() => clickable && setCollapsed(!collapsed)}
      >
        <span className={`${nameColor} text-xs font-mono shrink-0`}>{tool.name}</span>
        {summary && (
          <span className="text-[#888] text-xs font-mono truncate min-w-0 flex-1">{summary}</span>
        )}
        {hasResult && (
          <span className="text-[10px] text-[#555] shrink-0 transition-transform" style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>›</span>
        )}
      </div>
      {!collapsed && hasResult && (
        <pre className="ml-2 mt-1 mb-1 px-3 py-2 text-xs text-[#999] bg-[#0d0d0d] border-l-2 border-[#2a2a2a] m-0 overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto font-mono">
          {resultPreview}
        </pre>
      )}
    </div>
  )
}

export function TerminalTab({ projectName, initialSessionId }: TerminalTabProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobParam = searchParams.get('job')

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
    streamTools,
    streaming,
    streamStartedAt,
    claudeSessionId,
    currentJobId,
    lastStats,
    messageQueue,
    selectedItems,
    selectedDocs,
    pendingAutoSubmit,
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
  const [model, setModel] = useState<'haiku' | 'sonnet' | 'opus'>('haiku')
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const [showThinking, setShowThinking] = useState(false)
  const [pendingImages, setPendingImages] = useState<File[]>([])
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const [promptHistory, setPromptHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('tamtam-prompt-history') || '[]') } catch { return [] }
  })
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)
  const draftBeforeHistoryRef = useRef<string>('')
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [elapsedMs, setElapsedMs] = useState(0)
  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

  // Skills catalog
  const [allItems, setAllItems] = useState<SkillItem[]>([])
  const [skillSearch, setSkillSearch] = useState('')
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const skillSearchRef = useRef<HTMLInputElement>(null)
  const [skillUsage, setSkillUsage] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('tamtam-skill-usage') || '{}') } catch { return {} }
  })

  // Docs catalog
  const [allDocs, setAllDocs] = useState<DocItem[]>([])
  const [showDocsPicker, setShowDocsPicker] = useState(false)
  const [docsSearch, setDocsSearch] = useState('')
  const docsSearchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        const m = data.settings?.default_model
        if (m && ['haiku', 'sonnet', 'opus'].includes(m)) setModel(m as 'haiku' | 'sonnet' | 'opus')
      })
      .catch(() => {})
  }, [])

  // Preload sessions on fresh terminal landing (no session/job param)
  useEffect(() => {
    if (initialSessionId || jobParam) return
    loadSessions()
  }, [])

  // Restore session from URL param. Skipped if store already holds state for
  // this sessionId — preserves live streams and in-memory outputs across
  // unmounts / tab navigations.
  useEffect(() => {
    if (!initialSessionId) return
    const cur = terminalStore.get(projectName)
    // Already hydrated or streaming for this session → don't refetch; store wins.
    if (cur.restoredFor === initialSessionId) return
    if (cur.streaming) return
    if (cur.claudeSessionId === initialSessionId && cur.history.length > 0) {
      terminalStore.update(projectName, () => ({ restoredFor: initialSessionId }))
      return
    }

    fetch(`/api/jobs?project=${encodeURIComponent(projectName)}`)
      .then(r => r.json())
      .then(async (data) => {
        const jobs: any[] = data.jobs ?? []
        const matches = jobs
          .filter(j => j.session_id === initialSessionId && j.kind === 'run')
          .sort((a, b) => a.started_at - b.started_at)
        if (matches.length === 0) return

        const firstMatch = matches[0]
        let loadedSkills: SkillItem[] = []
        let loadedDocs: DocItem[] = []
        if (firstMatch.context_meta) {
          try {
            const meta = JSON.parse(firstMatch.context_meta)
            if (meta.skills && Array.isArray(meta.skills)) loadedSkills = meta.skills
            if (meta.docs && Array.isArray(meta.docs)) loadedDocs = meta.docs
          } catch {}
        }

        const lastMatch = matches[matches.length - 1]
        const lastIsRunning = lastMatch.status !== 'done' && lastMatch.finished_at === null
        const completedMatches = lastIsRunning ? matches.slice(0, -1) : matches

        const logData = await Promise.all(
          completedMatches.map(m =>
            fetch(`/api/jobs/${encodeURIComponent(m.id)}`).then(r => r.json()).catch(() => null)
          )
        )
        const entries: TermEntry[] = []
        completedMatches.forEach((m, i) => {
          const prompt = m.user_prompt || m.prompt
          if (prompt) entries.push({ role: 'user', text: prompt })
          const log = logData[i]?.log
          if (log) entries.push({ role: 'assistant', text: log })
        })

        if (lastIsRunning) {
          const prompt = lastMatch.user_prompt || lastMatch.prompt
          if (prompt) entries.push({ role: 'user', text: prompt })
          terminalStore.update(projectName, () => ({
            history: entries,
            claudeSessionId: initialSessionId,
            sessionKey: initialSessionId,
            selectedItems: loadedSkills,
            selectedDocs: loadedDocs,
            restoredFor: initialSessionId,
          }))
          terminalStore.startStream(projectName, lastMatch.id)
        } else {
          terminalStore.update(projectName, () => ({
            history: entries,
            claudeSessionId: initialSessionId,
            sessionKey: initialSessionId,
            selectedItems: loadedSkills,
            selectedDocs: loadedDocs,
            restoredFor: initialSessionId,
          }))
        }
      })
      .catch(() => {})
  }, [initialSessionId, projectName])

  // Load job output by job ID (e.g. from notification click)
  const jobLoadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!jobParam || initialSessionId) return
    if (jobLoadedRef.current === jobParam) return
    // If store already tracks this job, skip.
    const cur = terminalStore.get(projectName)
    if (cur.currentJobId === jobParam) {
      jobLoadedRef.current = jobParam
      return
    }
    jobLoadedRef.current = jobParam
    const loadJob = async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(jobParam)}`)
        if (!res.ok) return
        const data = await res.json()
        const entries: TermEntry[] = []
        const kind = data.kind || jobParam.split('-').slice(1, -1).join('-')
        const isClaudeJob = ['run', 'review', 'fix', 'fix-ci'].includes(data.kind) || (typeof data.kind === 'string' && data.kind.startsWith('agent:'))
        entries.push({ role: 'status', text: kind })
        if (isClaudeJob) {
          terminalStore.update(projectName, () => ({ history: entries }))
          terminalStore.startStream(projectName, jobParam)
        } else if (data.status === 'running' || data.finished_at === null) {
          terminalStore.update(projectName, () => ({ history: entries }))
          terminalStore.startStream(projectName, jobParam, true)
        } else {
          if (data.log) entries.push({ role: 'raw', text: data.log })
          const exitCode = data.exit_code
          if (exitCode !== undefined && exitCode !== null) {
            const ok = exitCode === 0
            entries.push({ role: ok ? 'status' : 'error', text: ok ? 'exit 0 — ok' : `exit ${exitCode}` })
          }
          terminalStore.update(projectName, () => ({ history: entries }))
        }
      } catch {}
    }
    loadJob()
  }, [jobParam, initialSessionId, projectName])

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
    if (showSkillPicker) skillSearchRef.current?.focus()
  }, [showSkillPicker])

  useEffect(() => {
    if (showDocsPicker) {
      if (allDocs.length === 0) {
        fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/docs`)
          .then(r => r.json())
          .then(data => setAllDocs(data.docs ?? []))
          .catch(() => {})
      }
      docsSearchRef.current?.focus()
    }
  }, [showDocsPicker, projectName, allDocs.length])

  const filteredItems = allItems.filter(item =>
    !selectedItems.some(sel => sel.id === item.id) &&
    (skillSearch === '' ||
      item.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
      item.description.toLowerCase().includes(skillSearch.toLowerCase()) ||
      item.id.toLowerCase().includes(skillSearch.toLowerCase()))
  ).sort((a, b) => (skillUsage[b.id] || 0) - (skillUsage[a.id] || 0))

  const toggleItem = (item: SkillItem) => {
    if (selectedItems.some(s => s.id === item.id)) {
      setSelectedItems(prev => prev.filter(s => s.id !== item.id))
    } else {
      setSelectedItems(prev => [...prev, item])
      setSkillSearch('')
      setShowSkillPicker(false)
      setSkillUsage(prev => {
        const updated = { ...prev, [item.id]: (prev[item.id] || 0) + 1 }
        try { localStorage.setItem('tamtam-skill-usage', JSON.stringify(updated)) } catch {}
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

  // Spinner animation during streaming
  useEffect(() => {
    if (!streaming) return
    const id = setInterval(() => setSpinnerFrame(f => f + 1), 80)
    return () => clearInterval(id)
  }, [streaming])

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

  // Live elapsed timer during streaming, anchored to store's streamStartedAt
  // so it survives unmount/remount.
  useEffect(() => {
    if (!streaming || !streamStartedAt) {
      setElapsedMs(0)
      return
    }
    setElapsedMs(Date.now() - streamStartedAt)
    const id = setInterval(() => {
      setElapsedMs(Date.now() - streamStartedAt)
    }, 100)
    return () => clearInterval(id)
  }, [streaming, streamStartedAt])

  const addImages = useCallback((files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/'))
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
    addImages(Array.from(e.dataTransfer.files))
  }, [addImages])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    if (files.some(f => f.type.startsWith('image/'))) {
      e.preventDefault()
      addImages(files)
    }
  }, [addImages])

  const removeImage = useCallback((idx: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== idx))
    setPendingImageUrls(prev => prev.filter((_, i) => i !== idx))
  }, [])

  // Auto-submit dequeued message after streaming ends
  useEffect(() => {
    if (streaming || !pendingAutoSubmit) return
    const text = pendingAutoSubmit
    terminalStore.clearPendingAutoSubmit(projectName)
    handleSubmit(text)
  }, [streaming, pendingAutoSubmit])

  const handleSubmit = async (autoText?: string) => {
    const text = (autoText !== undefined ? autoText : input).trim()
    if (!text && pendingImages.length === 0) return

    // Queue message if already streaming
    if (streaming) {
      if (text) {
        setMessageQueue(prev => [...prev, text])
        setInput('')
      }
      return
    }

    const imageUrls = [...pendingImageUrls]
    const imageFiles = [...pendingImages]
    if (text) {
      setPromptHistory(prev => {
        const updated = [text, ...prev.filter(p => p !== text)].slice(0, 50)
        try { localStorage.setItem('tamtam-prompt-history', JSON.stringify(updated)) } catch {}
        return updated
      })
    }
    setHistoryIdx(null)
    draftBeforeHistoryRef.current = ''
    setInput('')
    setPendingImages([])
    setPendingImageUrls([])

    terminalStore.update(projectName, (s) => ({
      history: [...s.history, { role: 'user', text, imageUrls: imageUrls.length > 0 ? imageUrls : undefined }],
      lastStats: null,
    }))

    try {
      const cur = terminalStore.get(projectName)
      const sessionId = cur.claudeSessionId
      const isFollowUp = !!sessionId
      let fullPrompt = text

      if (!isFollowUp) {
        const dbSkills = selectedItems.filter(s => s.source === 'db' && s.content)
        if (dbSkills.length > 0) {
          const skillContext = dbSkills.map(s => `## ${s.name}\n${s.content}`).join('\n\n---\n\n')
          fullPrompt = skillContext + '\n\n---\n\n' + fullPrompt
        }
        if (selectedDocs.length > 0) {
          const docContext = selectedDocs.map(d => `## ${d.name}\n${d.content}`).join('\n\n---\n\n')
          fullPrompt = docContext + '\n\n---\n\n' + fullPrompt
        }
      }

      const personaPaths = !isFollowUp
        ? selectedItems.filter(s => s.source === 'file').map(s => s.id.replace('persona:', ''))
        : []

      const contextMetaStr = !isFollowUp
        ? JSON.stringify({
            skills: selectedItems.map(s => ({ id: s.id, name: s.name, description: s.description, content: s.content, source: s.source })),
            docs: selectedDocs.map(d => ({ name: d.name, content: d.content })),
          })
        : undefined

      const result = await runProject(
        projectName, fullPrompt,
        imageFiles.length > 0 ? imageFiles : undefined,
        undefined,
        personaPaths.length > 0 ? personaPaths : undefined,
        model,
        sessionId || undefined,
        contextMetaStr,
        text
      )
      terminalStore.startStream(projectName, result.job_id)
    } catch (err) {
      terminalStore.update(projectName, (s) => ({
        history: [...s.history, { role: 'error', text: err instanceof Error ? err.message : 'Failed to start' }],
        streaming: false,
      }))
    }
  }

  const loadSessions = async () => {
    setLoadingSessions(true)
    try {
      const res = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}`)
      const data = await res.json()
      const jobs: any[] = (data.jobs ?? [])
        .filter((j: any) => j.kind === 'run')
        .sort((a: any, b: any) => b.started_at - a.started_at)

      const seen = new Set<string>()
      const grouped: SessionItem[] = []
      for (const j of jobs) {
        const key = j.session_id || `job:${j.id}`
        if (seen.has(key)) continue
        seen.add(key)
        const sameSession = j.session_id
          ? jobs.filter(o => o.session_id === j.session_id)
          : [j]
        const earliest = sameSession[sameSession.length - 1]
        const latest = sameSession[0]
        grouped.push({
          id: latest.id,
          prompt: earliest.user_prompt || earliest.prompt,
          startedAt: latest.started_at,
          finishedAt: latest.finished_at,
          sessionId: latest.session_id,
          exitCode: latest.exit_code,
        })
        if (grouped.length >= 100) break
      }
      setSessions(grouped)
    } catch {}
    setLoadingSessions(false)
  }

  const restoreSession = useCallback(async (session: SessionItem) => {
    setShowSessions(false)

    // If switching to a different session, close any active stream so state
    // for the new session is clean. Don't wipe current session unless user
    // confirms — navigation replaces.
    if (session.sessionId) {
      if (terminalStore.get(projectName).claudeSessionId !== session.sessionId) {
        terminalStore.reset(projectName)
      }
      try {
        const listRes = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}`)
        const listData = await listRes.json()
        const jobs: any[] = listData.jobs ?? []
        const matches = jobs
          .filter(j => j.session_id === session.sessionId && j.kind === 'run')
          .sort((a, b) => a.started_at - b.started_at)
        if (matches.length > 0) {
          const firstMatch = matches[0]
          let loadedSkills: SkillItem[] = []
          let loadedDocs: DocItem[] = []
          if (firstMatch.context_meta) {
            try {
              const meta = JSON.parse(firstMatch.context_meta)
              if (meta.skills && Array.isArray(meta.skills)) loadedSkills = meta.skills
              if (meta.docs && Array.isArray(meta.docs)) loadedDocs = meta.docs
            } catch {}
          }
          const lastMatch = matches[matches.length - 1]
          const lastIsRunning = lastMatch.status !== 'done' && lastMatch.finished_at === null
          const completedMatches = lastIsRunning ? matches.slice(0, -1) : matches
          const logData = await Promise.all(
            completedMatches.map(m =>
              fetch(`/api/jobs/${encodeURIComponent(m.id)}`).then(r => r.json()).catch(() => null)
            )
          )
          const entries: TermEntry[] = []
          completedMatches.forEach((m, i) => {
            const prompt = m.user_prompt || m.prompt
            if (prompt) entries.push({ role: 'user', text: prompt })
            const log = logData[i]?.log
            if (log) entries.push({ role: 'assistant', text: log })
          })
          router.replace(`/project/${projectName}/terminal/${session.sessionId}`)
          if (lastIsRunning) {
            const prompt = lastMatch.user_prompt || lastMatch.prompt
            if (prompt) entries.push({ role: 'user', text: prompt })
            terminalStore.update(projectName, () => ({
              history: entries,
              claudeSessionId: session.sessionId,
              sessionKey: session.sessionId!,
              selectedItems: loadedSkills,
              selectedDocs: loadedDocs,
              restoredFor: session.sessionId,
            }))
            terminalStore.startStream(projectName, lastMatch.id)
          } else {
            terminalStore.update(projectName, () => ({
              history: entries,
              claudeSessionId: session.sessionId,
              sessionKey: session.sessionId!,
              selectedItems: loadedSkills,
              selectedDocs: loadedDocs,
              restoredFor: session.sessionId,
            }))
          }
          return
        }
      } catch {}
    }

    // Fallback: single-job restore for jobs without a session_id
    const isStillRunning = session.finishedAt === null && session.exitCode === null
    if (isStillRunning) {
      terminalStore.reset(projectName)
      terminalStore.update(projectName, () => ({
        claudeSessionId: session.sessionId,
        history: session.prompt ? [{ role: 'user', text: session.prompt }] : [],
      }))
      terminalStore.startStream(projectName, session.id)
      return
    }
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(session.id)}`)
      const data = await res.json()
      const entries: TermEntry[] = []
      if (session.prompt) entries.push({ role: 'user', text: session.prompt })
      if (data.log) entries.push({ role: 'assistant', text: data.log })
      let loadedSkills: SkillItem[] = []
      let loadedDocs: DocItem[] = []
      if (data.context_meta) {
        try {
          const meta = JSON.parse(data.context_meta)
          if (meta.skills && Array.isArray(meta.skills)) loadedSkills = meta.skills
          if (meta.docs && Array.isArray(meta.docs)) loadedDocs = meta.docs
        } catch {}
      }
      terminalStore.reset(projectName)
      terminalStore.update(projectName, () => ({
        history: entries,
        claudeSessionId: session.sessionId || null,
        sessionKey: session.sessionId || 'new',
        selectedItems: loadedSkills,
        selectedDocs: loadedDocs,
      }))
    } catch {}
  }, [router, projectName])

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

  const lastStreamLine = (() => {
    const trimmed = streamBuffer.trimEnd()
    const lastNl = trimmed.lastIndexOf('\n')
    const line = lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1)
    return line.trim().slice(0, 120) || ''
  })()

  return (
    <div
      className="mt-4 flex flex-col"
      style={{ height: 'calc(100vh - 280px)', minHeight: '400px' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`flex-1 bg-[#111] rounded-lg border ${dragOver ? 'border-accent' : 'border-[#2a2a2a]'} flex flex-col overflow-hidden relative`}>
        {!autoScroll && (
          <button
            className="absolute right-4 bottom-24 z-40 px-2.5 py-1 text-[11px] rounded-full bg-accent/90 text-white hover:bg-accent cursor-pointer border-none font-mono shadow-lg"
            onClick={scrollToBottom}
            title="Jump to bottom"
          >
            ↓ latest
          </button>
        )}
        {dragOver && (
          <div className="absolute inset-0 bg-accent/10 z-50 flex items-center justify-center pointer-events-none rounded-lg">
            <span className="text-accent text-sm font-mono">drop image</span>
          </div>
        )}

        {/* Terminal header */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[#1a1a1a] border-b border-[#2a2a2a] shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              className="text-[11px] px-2 py-1 h-[26px] rounded bg-[#252525] text-[#888] hover:text-[#ccc] cursor-pointer border-none font-mono leading-none"
              onClick={handleNewSession}
              title="New session"
            >
              new
            </button>
            <button
              className="text-[11px] px-2 py-1 h-[26px] rounded bg-[#252525] text-[#888] hover:text-[#ccc] cursor-pointer border-none font-mono leading-none flex items-center gap-1"
              onClick={() => { if (!showSessions) loadSessions(); setShowSessions(s => !s) }}
              title="Previous sessions"
            >
              {showSessions ? 'close' : 'sessions'}
              {!showSessions && sessions.length > 0 && (
                <span className="text-[10px] text-[#555]">
                  {sessions.length}
                  {sessions.some(s => s.finishedAt === null && s.exitCode === null) && (
                    <span className="ml-0.5 text-status-warning">●</span>
                  )}
                </span>
              )}
            </button>
            {streaming && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-warning/20 text-status-warning font-mono leading-none flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse" />
                live
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              className={`text-[11px] px-2 py-1 h-[26px] rounded cursor-pointer border-none font-mono leading-none ${showThinking ? 'bg-accent/20 text-accent' : 'bg-[#252525] text-[#888] hover:text-[#ccc]'}`}
              onClick={() => setShowThinking(s => !s)}
              title="Toggle thinking blocks"
            >
              thinking
            </button>
            {selectedItems.map(item => (
              <span key={item.id} className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono">
                {item.name}
                <button className="ml-1 text-accent/50 hover:text-accent cursor-pointer" onClick={() => toggleItem(item)}>x</button>
              </span>
            ))}
            {selectedDocs.map(doc => (
              <span key={doc.name} className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono">
                {doc.name}
                <button className="ml-1 text-accent/50 hover:text-accent cursor-pointer" onClick={() => toggleDoc(doc)}>x</button>
              </span>
            ))}
            <div className="relative">
              <button
                className="text-[11px] px-2 py-1 h-[26px] rounded bg-[#252525] text-[#888] hover:text-[#ccc] cursor-pointer border-none font-mono leading-none"
                onClick={() => setShowSkillPicker(!showSkillPicker)}
              >
                +skill
              </button>
              {showSkillPicker && (
                <div className="absolute top-full right-0 mt-1 w-96 bg-[#1a1a1a] border border-[#333] rounded-lg shadow-xl z-50 overflow-hidden">
                  <input
                    ref={skillSearchRef}
                    type="text"
                    className="w-full px-3 py-2.5 text-sm bg-[#111] border-b border-[#333] text-[#ccc] outline-none placeholder:text-[#555] font-mono"
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    placeholder="search skills..."
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setShowSkillPicker(false); setSkillSearch('') }
                      if (e.key === 'Enter' && filteredItems.length > 0) toggleItem(filteredItems[0])
                    }}
                  />
                  <div className="max-h-80 overflow-y-auto">
                    {filteredItems.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-[#555]">
                        {allItems.length === 0 ? 'no skills' : 'no matches'}
                      </div>
                    ) : (
                      filteredItems.slice(0, 50).map(item => (
                        <button
                          key={item.id}
                          className="w-full px-3 py-2 text-left text-xs hover:bg-[#252525] cursor-pointer border-none bg-transparent text-[#ccc] font-mono flex items-center justify-between gap-2"
                          onClick={() => toggleItem(item)}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate">{item.name}</span>
                            <span className="text-[#444] shrink-0">{item.source === 'db' ? 'db' : 'file'}</span>
                          </div>
                          {(skillUsage[item.id] || 0) > 0 && (
                            <span className="text-[10px] text-[#555] shrink-0">{skillUsage[item.id]}</span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="relative">
              <button
                className="text-[11px] px-2 py-1 h-[26px] rounded bg-[#252525] text-[#888] hover:text-[#ccc] cursor-pointer border-none font-mono leading-none"
                onClick={() => setShowDocsPicker(!showDocsPicker)}
              >
                +docs
              </button>
              {showDocsPicker && (
                <div className="absolute top-full right-0 mt-1 w-72 bg-[#1a1a1a] border border-[#333] rounded-lg shadow-xl z-50 overflow-hidden">
                  <input
                    ref={docsSearchRef}
                    type="text"
                    className="w-full px-3 py-2.5 text-sm bg-[#111] border-b border-[#333] text-[#ccc] outline-none placeholder:text-[#555] font-mono"
                    value={docsSearch}
                    onChange={(e) => setDocsSearch(e.target.value)}
                    placeholder="search docs..."
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setShowDocsPicker(false); setDocsSearch('') }
                      if (e.key === 'Enter' && filteredDocs.length > 0) toggleDoc(filteredDocs[0])
                    }}
                  />
                  <div className="max-h-80 overflow-y-auto">
                    {filteredDocs.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-[#555]">
                        {allDocs.length === 0 ? 'no docs' : 'no matches'}
                      </div>
                    ) : (
                      filteredDocs.map(doc => (
                        <button
                          key={doc.name}
                          className="w-full px-3 py-2 text-left text-xs hover:bg-[#252525] cursor-pointer border-none bg-transparent text-[#ccc] font-mono"
                          onClick={() => toggleDoc(doc)}
                        >
                          {doc.name}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
            <select
              className="text-[11px] px-2 py-1 h-[26px] rounded bg-[#252525] text-[#888] cursor-pointer outline-none border-none font-mono leading-none"
              value={model}
              onChange={async (e) => {
                const m = e.target.value as 'haiku' | 'sonnet' | 'opus'
                setModel(m)
                await fetch('/api/settings', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ default_model: m }),
                }).catch(() => {})
              }}
            >
              <option value="haiku">haiku</option>
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
            </select>
          </div>
        </div>

        {/* Sessions panel */}
        {showSessions && (
          <div className="border-b border-[#2a2a2a] bg-[#151515] overflow-y-auto shrink-0" style={{ maxHeight: '200px' }}>
            {loadingSessions ? (
              <div className="px-4 py-3 text-xs text-[#555] font-mono">loading...</div>
            ) : sessions.length === 0 ? (
              <div className="px-4 py-3 text-xs text-[#555] font-mono">no sessions</div>
            ) : (
              sessions.map(session => {
                const isRunning = session.finishedAt === null && session.exitCode === null
                const isSuccess = session.exitCode === 0
                const prompt = session.prompt
                  ? session.prompt.length > 60 ? session.prompt.slice(0, 60) + '...' : session.prompt
                  : '(no prompt)'
                const secs = Math.floor(Date.now() / 1000 - session.startedAt)
                const timeAgo = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`
                return (
                  <button
                    key={session.id}
                    className="flex items-center gap-3 w-full px-4 py-2 text-left hover:bg-[#1e1e1e] border-none bg-transparent border-b border-[#222] last:border-b-0 cursor-pointer"
                    onClick={() => restoreSession(session)}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-status-warning animate-pulse' : isSuccess ? 'bg-status-success' : 'bg-status-error'}`} />
                    <span className="text-xs text-[#ccc] font-mono truncate flex-1">{prompt}</span>
                    <span className="text-[10px] text-[#555] font-mono shrink-0">{timeAgo}</span>
                    {session.sessionId && <span className="text-[10px] text-[#444] font-mono shrink-0">{session.sessionId.slice(0, 8)}</span>}
                  </button>
                )
              })
            )}
          </div>
        )}

        {/* Terminal body */}
        <div
          ref={termRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto font-mono text-sm flex flex-col"
        >
          {!streaming && history.length === 0 && !claudeSessionId && sessions.length > 0 && (
            <div className="px-4 py-3 border-b border-[#1e1e1e]">
              <div className="text-[10px] text-[#555] uppercase tracking-wider mb-2 font-mono">
                resume recent
              </div>
              <div className="flex flex-col gap-1">
                {sessions.slice(0, 5).map(session => {
                  const isRunning = session.finishedAt === null && session.exitCode === null
                  const isSuccess = session.exitCode === 0
                  const prompt = session.prompt
                    ? session.prompt.length > 90 ? session.prompt.slice(0, 90) + '...' : session.prompt
                    : '(no prompt)'
                  const secs = Math.floor(Date.now() / 1000 - session.startedAt)
                  const timeAgo = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : secs < 86400 ? `${Math.floor(secs / 3600)}h ago` : `${Math.floor(secs / 86400)}d ago`
                  return (
                    <button
                      key={session.id}
                      className="flex items-center gap-3 w-full px-3 py-1.5 text-left hover:bg-[#1a1a1a] rounded cursor-pointer border-none bg-transparent group"
                      onClick={() => restoreSession(session)}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isRunning ? 'bg-status-warning animate-pulse' : isSuccess ? 'bg-status-success' : 'bg-status-error'}`} />
                      <span className="text-xs text-[#ccc] font-mono truncate flex-1 group-hover:text-[#fff]">{prompt}</span>
                      {isRunning && <span className="text-[10px] text-status-warning font-mono shrink-0">running</span>}
                      <span className="text-[10px] text-[#555] font-mono shrink-0">{timeAgo}</span>
                    </button>
                  )
                })}
              </div>
              {sessions.length > 5 && (
                <button
                  className="mt-2 text-[10px] text-[#555] hover:text-[#888] cursor-pointer border-none bg-transparent font-mono"
                  onClick={() => { if (!showSessions) loadSessions(); setShowSessions(true) }}
                >
                  show all {sessions.length} →
                </button>
              )}
            </div>
          )}

          {history.map((entry, i) => (
            entry.role === 'thinking' ? (
              showThinking && (
                <div key={i} className="px-4 py-2 border-l-2 border-[#444] ml-4 mr-4 my-1">
                  <div className="text-[10px] text-[#666] mb-1 uppercase tracking-wider">thinking</div>
                  <div className="text-[#888] text-xs whitespace-pre-wrap">{entry.text}</div>
                </div>
              )
            ) : entry.role === 'tool' && entry.tool ? (
              <ToolBlock key={i} tool={entry.tool} />
            ) : (
            <div
              key={i}
              className={`group relative px-4 py-2 ${
                entry.role === 'user' ? 'text-accent whitespace-pre-wrap' :
                entry.role === 'error' ? 'text-status-error whitespace-pre-wrap' :
                entry.role === 'status' ? 'text-[#555] whitespace-pre-wrap' :
                entry.role === 'raw' ? 'text-[#c0c0c0] font-mono text-xs whitespace-pre-wrap' :
                'text-[#e0e0e0] terminal-markdown'
              }`}
            >
              {entry.role === 'user' && <span className="text-accent mr-2">#</span>}
              {entry.role === 'assistant'
                ? (hasAnsi(entry.text)
                    ? <pre className="whitespace-pre-wrap font-mono text-xs m-0">{renderAnsi(entry.text)}</pre>
                    : <Markdown>{entry.text}</Markdown>)
                : hasAnsi(entry.text)
                  ? <pre className="whitespace-pre-wrap font-mono text-xs m-0 inline">{renderAnsi(entry.text)}</pre>
                  : entry.text}
              {entry.imageUrls && entry.imageUrls.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {entry.imageUrls.map((url, j) => (
                    <img key={j} src={url} alt="attachment" className="max-h-40 max-w-[240px] rounded border border-[#333] object-contain bg-[#1a1a1a]" />
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

          {/* Live streamed assistant text */}
          {streaming && streamBuffer && (
            <div className="px-4 py-2 text-[#e0e0e0] terminal-markdown">
              {hasAnsi(streamBuffer)
                ? <pre className="whitespace-pre-wrap font-mono text-xs m-0">{renderAnsi(streamBuffer)}</pre>
                : <Markdown>{streamBuffer}</Markdown>}
            </div>
          )}

          {streaming && showThinking && thinkingBuffer && (
            <div className="px-4 py-2 border-l-2 border-[#444] ml-4 mr-4 my-1">
              <div className="text-[10px] text-[#666] mb-1 uppercase tracking-wider">thinking</div>
              <div className="text-[#888] text-xs whitespace-pre-wrap">{thinkingBuffer}</div>
            </div>
          )}

          {streaming && streamTools.length > 0 && streamTools.map((tool, i) => (
            <ToolBlock key={`stream-tool-${i}`} tool={tool} />
          ))}

          {streaming && (
            <div className="px-4 py-2 flex items-center gap-2">
              <span className="text-accent font-mono text-sm">{spinnerChars[spinnerFrame % spinnerChars.length]}</span>
              <span className="text-status-warning text-xs font-mono shrink-0">{(elapsedMs / 1000).toFixed(1)}s</span>
              <span className="text-[#666] text-xs font-mono truncate flex-1">{lastStreamLine || 'thinking...'}</span>
              <button
                className="text-[10px] px-1.5 py-0.5 rounded bg-status-error/20 text-status-error hover:bg-status-error/40 cursor-pointer border-none font-mono leading-none shrink-0"
                onClick={handleCancel}
                title="Cancel execution"
              >
                cancel
              </button>
            </div>
          )}

          {messageQueue.length > 0 && (
            <div className="px-4 pb-1">
              {messageQueue.map((msg, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-[#888] font-mono py-0.5">
                  <span className="text-[#666]">{i + 1}.</span>
                  <span className="truncate flex-1">{msg}</span>
                  <button
                    className="text-[#666] hover:text-[#aaa] cursor-pointer border-none bg-transparent font-mono shrink-0"
                    onClick={() => setMessageQueue(prev => prev.filter((_, j) => j !== i))}
                  >✕</button>
                </div>
              ))}
            </div>
          )}

          {!streaming && pendingImageUrls.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-2">
              {pendingImageUrls.map((url, i) => (
                <div key={i} className="relative group">
                  <img src={url} alt="pending" className="max-h-20 max-w-[140px] rounded border border-[#333] object-contain bg-[#1a1a1a]" />
                  <button
                    className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-[#1a1a1a] text-[#888] hover:text-[#fff] text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-pointer border-none"
                    onClick={(e) => { e.stopPropagation(); removeImage(i) }}
                  >x</button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-start px-4 py-1.5">
            <span className={`shrink-0 mr-1 mt-0.5 ${streaming ? 'text-[#555]' : 'text-accent'}`}>{streaming ? '>' : '#'}</span>
            <textarea
              ref={inputRef}
              rows={1}
              className="flex-1 bg-transparent border-none outline-none text-[#e0e0e0] font-mono text-sm placeholder:text-[#444] resize-none overflow-y-auto leading-relaxed"
              style={{ maxHeight: '200px' }}
              value={input}
              onChange={(e) => {
                const v = e.target.value
                setInput(v)
                if (historyIdx !== null && v !== promptHistory[historyIdx]) {
                  setHistoryIdx(null)
                }
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  handleSubmit()
                  if (inputRef.current) inputRef.current.style.height = 'auto'
                } else if (e.key === 'Escape') {
                  if (streaming) {
                    e.preventDefault()
                    handleCancel()
                  } else if (input) {
                    e.preventDefault()
                    setInput('')
                    if (inputRef.current) inputRef.current.style.height = 'auto'
                  }
                } else if (e.key === 'ArrowUp' && promptHistory.length > 0) {
                  const el = inputRef.current
                  const beforeCaret = el ? el.value.slice(0, el.selectionStart) : ''
                  const onFirstLine = !beforeCaret.includes('\n')
                  if (!onFirstLine) return
                  e.preventDefault()
                  if (historyIdx === null) draftBeforeHistoryRef.current = input
                  const nextIdx = historyIdx === null ? 0 : Math.min(historyIdx + 1, promptHistory.length - 1)
                  setHistoryIdx(nextIdx)
                  setInput(promptHistory[nextIdx])
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
                    setHistoryIdx(null)
                    setInput(draftBeforeHistoryRef.current)
                  } else {
                    const nextIdx = historyIdx - 1
                    setHistoryIdx(nextIdx)
                    setInput(promptHistory[nextIdx])
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
              onPaste={handlePaste}
              placeholder={streaming ? 'queue a message... (Esc cancels)' : claudeSessionId ? 'follow-up... (↑/↓ history, Shift+Enter newline)' : 'type a message... (↑/↓ history, Shift+Enter newline)'}
              autoFocus
            />
            {messageQueue.length > 0 && (
              <div className="flex items-center gap-1 ml-2 shrink-0 mt-0.5">
                <span className="text-[10px] text-[#555] font-mono">{messageQueue.length} queued</span>
                <button
                  className="text-[10px] text-[#555] hover:text-[#888] cursor-pointer border-none bg-transparent font-mono"
                  onClick={() => setMessageQueue([])}
                  title="Clear queue"
                >✕</button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 px-4 py-1 border-t border-[#1e1e1e] shrink-0 text-[10px] text-[#444] font-mono">
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
        </div>
      </div>
    </div>
  )
}
