'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { runProject, fetchSkills, fetchPersonas } from '@/lib/client-api'
import type { Skill, Persona } from '@/lib/client-api'

interface TermEntry {
  role: 'user' | 'assistant' | 'status' | 'error' | 'thinking'
  text: string
  imageUrls?: string[]
}

interface SessionItem {
  id: string
  prompt: string | null
  startedAt: number
  finishedAt: number | null
  sessionId: string | null
  exitCode: number | null
}

interface ExperimentalTabProps {
  projectName: string
  initialSessionId?: string
}

export function ExperimentalTab({ projectName, initialSessionId }: ExperimentalTabProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobParam = searchParams.get('job')
  const [input, setInput] = useState('')
  const [model, setModel] = useState<'haiku' | 'sonnet' | 'opus'>('haiku')
  const [history, setHistory] = useState<TermEntry[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamBuffer, setStreamBuffer] = useState('')
  const streamBufferRef = useRef('')
  const [displayedLength, setDisplayedLength] = useState(0)
  const [thinkingBuffer, setThinkingBuffer] = useState('')
  const thinkingBufferRef = useRef('')
  const [showThinking, setShowThinking] = useState(false)
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(initialSessionId ?? null)
  const [pendingImages, setPendingImages] = useState<File[]>([])
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [messageQueue, setMessageQueue] = useState<string[]>([])
  const messageQueueRef = useRef<string[]>([])
  const pendingAutoSubmitRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const esRef = useRef<EventSource | null>(null)
  const animFrameRef = useRef<number | null>(null)
  const lastTimeRef = useRef(0)

  // Skills
  interface SkillItem { id: string; name: string; description: string; content?: string; source: 'db' | 'file' }
  const [allItems, setAllItems] = useState<SkillItem[]>([])
  const [selectedItems, setSelectedItems] = useState<SkillItem[]>([])
  const [skillSearch, setSkillSearch] = useState('')
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const skillSearchRef = useRef<HTMLInputElement>(null)
  const [skillUsage, setSkillUsage] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('tamtam-skill-usage') || '{}') } catch { return {} }
  })

  // Docs
  interface DocItem { name: string; content: string }
  const [allDocs, setAllDocs] = useState<DocItem[]>([])
  const [selectedDocs, setSelectedDocs] = useState<DocItem[]>([])
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

  // Restore session from URL param
  useEffect(() => {
    if (!initialSessionId) return
    fetch(`/api/jobs?project=${encodeURIComponent(projectName)}`)
      .then(r => r.json())
      .then(async (data) => {
        const jobs: any[] = data.jobs ?? []
        const match = jobs
          .filter(j => j.session_id === initialSessionId)
          .sort((a, b) => a.started_at - b.started_at)[0]
        if (!match) return
        if (match.context_meta) {
          try {
            const meta = JSON.parse(match.context_meta)
            if (meta.skills && Array.isArray(meta.skills)) setSelectedItems(meta.skills)
            if (meta.docs && Array.isArray(meta.docs)) setSelectedDocs(meta.docs)
          } catch {}
        }
        setClaudeSessionId(initialSessionId)
        if (match.status === 'done' || match.finished_at !== null) {
          const res = await fetch(`/api/jobs/${encodeURIComponent(match.id)}`)
          const jobData = await res.json()
          const entries: TermEntry[] = []
          const displayPrompt = match.user_prompt || match.prompt
          if (displayPrompt) entries.push({ role: 'user', text: displayPrompt })
          if (jobData.log) entries.push({ role: 'assistant', text: jobData.log })
          setHistory(entries)
        } else {
          setStreaming(true)
          const displayPrompt = match.user_prompt || match.prompt
          if (displayPrompt) setHistory([{ role: 'user', text: displayPrompt }])
          startStreaming(match.id)
        }
      })
      .catch(() => {})
  }, [initialSessionId])

  // Load job output by job ID (e.g. from notification click for review/test jobs)
  useEffect(() => {
    if (!jobParam || initialSessionId) return
    const loadJob = async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(jobParam)}`)
        if (!res.ok) return
        const data = await res.json()
        const entries: TermEntry[] = []
        const kind = data.kind || jobParam.split('-').slice(1, -1).join('-')
        entries.push({ role: 'status', text: `${kind} — ${data.status || 'done'}` })
        if (data.status === 'running' || data.finished_at === null) {
          setStreaming(true)
          setHistory(entries)
          startStreaming(jobParam)
        } else {
          if (data.log) entries.push({ role: 'assistant', text: data.log })
          setHistory(entries)
        }
      } catch {}
    }
    loadJob()
  }, [jobParam, initialSessionId])

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

  // Typewriter animation
  useEffect(() => {
    if (displayedLength >= streamBuffer.length) return
    const animate = (now: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = now
      const elapsed = now - lastTimeRef.current
      const charsToAdd = Math.max(1, Math.floor(elapsed / 1.25))
      if (charsToAdd > 0) {
        setDisplayedLength(prev => Math.min(prev + charsToAdd, streamBuffer.length))
        lastTimeRef.current = now
      }
      animFrameRef.current = requestAnimationFrame(animate)
    }
    animFrameRef.current = requestAnimationFrame(animate)
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      lastTimeRef.current = 0
    }
  }, [streamBuffer.length, displayedLength])

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [history, streamBuffer, displayedLength, autoScroll])

  const handleScroll = () => {
    if (!termRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = termRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }

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

  useEffect(() => {
    return () => { esRef.current?.close() }
  }, [])

  const startStreaming = useCallback((jobId: string) => {
    const es = new EventSource(`/api/streaming/${jobId}`)
    esRef.current = es

    es.onmessage = (event) => {
      streamBufferRef.current += event.data
      setStreamBuffer(streamBufferRef.current)
    }

    es.addEventListener('thinking', (event) => {
      thinkingBufferRef.current += (event as MessageEvent).data
      setThinkingBuffer(thinkingBufferRef.current)
    })

    es.addEventListener('done', (event) => {
      const metadata = JSON.parse((event as MessageEvent).data)
      es.close()
      esRef.current = null
      const buf = streamBufferRef.current
      const thinking = thinkingBufferRef.current
      streamBufferRef.current = ''
      thinkingBufferRef.current = ''
      const sid = metadata.sessionId || null
      setClaudeSessionId(sid)
      if (sid && !initialSessionId) {
        router.replace(`/project/${projectName}/experimental/${sid}`)
      }
      const newEntries: TermEntry[] = []
      if (thinking) newEntries.push({ role: 'thinking', text: thinking })
      if (buf) newEntries.push({ role: 'assistant', text: buf })
      setHistory(prev => [...prev, ...newEntries])
      setStreamBuffer('')
      setThinkingBuffer('')
      setDisplayedLength(0)
      setStreaming(false)

      // Dequeue next message if any
      const queue = messageQueueRef.current
      if (queue.length > 0) {
        const [next, ...rest] = queue
        messageQueueRef.current = rest
        setMessageQueue(rest)
        pendingAutoSubmitRef.current = next
      } else {
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    })

    es.onerror = () => {
      es.close()
      esRef.current = null
      const buf = streamBufferRef.current
      const thinking = thinkingBufferRef.current
      streamBufferRef.current = ''
      thinkingBufferRef.current = ''
      const newEntries: TermEntry[] = []
      if (thinking) newEntries.push({ role: 'thinking', text: thinking })
      if (buf) newEntries.push({ role: 'assistant', text: buf })
      if (newEntries.length === 0) newEntries.push({ role: 'error', text: 'Connection error' })
      setHistory(prev => [...prev, ...newEntries])
      setStreamBuffer('')
      setThinkingBuffer('')
      setDisplayedLength(0)
      setStreaming(false)
      // Drop queue on error — don't auto-submit after a failed run
      messageQueueRef.current = []
      setMessageQueue([])
      pendingAutoSubmitRef.current = null
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [])

  // Auto-submit dequeued message after streaming ends
  useEffect(() => {
    if (streaming || !pendingAutoSubmitRef.current) return
    const text = pendingAutoSubmitRef.current
    pendingAutoSubmitRef.current = null
    handleSubmit(text)
  }, [streaming])

  const handleSubmit = async (autoText?: string) => {
    const text = (autoText !== undefined ? autoText : input).trim()
    if (!text && pendingImages.length === 0) return

    // Queue message if already streaming
    if (streaming) {
      if (text) {
        const updated = [...messageQueueRef.current, text]
        messageQueueRef.current = updated
        setMessageQueue(updated)
        setInput('')
      }
      return
    }

    const imageUrls = [...pendingImageUrls]
    const imageFiles = [...pendingImages]
    setInput('')
    setPendingImages([])
    setPendingImageUrls([])
    setHistory(prev => [...prev, { role: 'user', text, imageUrls: imageUrls.length > 0 ? imageUrls : undefined }])
    setStreaming(true)
    streamBufferRef.current = ''
    thinkingBufferRef.current = ''
    setStreamBuffer('')
    setThinkingBuffer('')
    setDisplayedLength(0)

    try {
      const isFollowUp = !!claudeSessionId
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
        claudeSessionId || undefined,
        contextMetaStr,
        text
      )
      startStreaming(result.job_id)
    } catch (err) {
      setHistory(prev => [...prev, { role: 'error', text: err instanceof Error ? err.message : 'Failed to start' }])
      setStreaming(false)
    }
  }

  const loadSessions = async () => {
    setLoadingSessions(true)
    try {
      const res = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}`)
      const data = await res.json()
      const jobs = (data.jobs ?? [])
        .filter((j: any) => j.kind === 'run')
        .sort((a: any, b: any) => b.started_at - a.started_at)
        .slice(0, 100)
      setSessions(jobs.map((j: any) => ({
        id: j.id,
        prompt: j.user_prompt || j.prompt,
        startedAt: j.started_at,
        finishedAt: j.finished_at,
        sessionId: j.session_id,
        exitCode: j.exit_code,
      })))
    } catch {}
    setLoadingSessions(false)
  }

  const restoreSession = useCallback(async (session: SessionItem) => {
    setShowSessions(false)
    const isStillRunning = session.finishedAt === null && session.exitCode === null
    if (isStillRunning) {
      setClaudeSessionId(session.sessionId)
      setHistory(session.prompt ? [{ role: 'user', text: session.prompt }] : [])
      setStreaming(true)
      if (session.sessionId) {
        router.replace(`/project/${projectName}/experimental/${session.sessionId}`)
      }
      startStreaming(session.id)
      return
    }
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(session.id)}`)
      const data = await res.json()
      const entries: TermEntry[] = []
      if (session.prompt) entries.push({ role: 'user', text: session.prompt })
      if (data.log) entries.push({ role: 'assistant', text: data.log })
      streamBufferRef.current = ''
      setStreamBuffer('')
      setDisplayedLength(0)
      setHistory(entries)
      setClaudeSessionId(session.sessionId || null)
      if (data.context_meta) {
        try {
          const meta = JSON.parse(data.context_meta)
          if (meta.skills && Array.isArray(meta.skills)) setSelectedItems(meta.skills)
          if (meta.docs && Array.isArray(meta.docs)) setSelectedDocs(meta.docs)
        } catch {}
      }
      if (session.sessionId) {
        router.replace(`/project/${projectName}/experimental/${session.sessionId}`)
      }
    } catch {}
  }, [startStreaming, router, projectName])

  const handleNewSession = () => {
    esRef.current?.close()
    setClaudeSessionId(null)
    setHistory([])
    streamBufferRef.current = ''
    thinkingBufferRef.current = ''
    setStreamBuffer('')
    setThinkingBuffer('')
    setDisplayedLength(0)
    setStreaming(false)
    setSelectedDocs([])
    messageQueueRef.current = []
    setMessageQueue([])
    pendingAutoSubmitRef.current = null
    router.replace(`/project/${projectName}/experimental`)
    inputRef.current?.focus()
  }

  const visibleStream = streamBuffer.slice(0, displayedLength)

  return (
    <div
      className="mt-4 flex flex-col"
      style={{ height: 'calc(100vh - 280px)', minHeight: '400px' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`flex-1 bg-[#111] rounded-lg border ${dragOver ? 'border-accent' : 'border-[#2a2a2a]'} flex flex-col overflow-hidden relative`}>
        {dragOver && (
          <div className="absolute inset-0 bg-accent/10 z-50 flex items-center justify-center pointer-events-none rounded-lg">
            <span className="text-accent text-sm font-mono">drop image</span>
          </div>
        )}

        {/* Terminal header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-[#1a1a1a] border-b border-[#2a2a2a] shrink-0">
          {/* Left: session controls */}
          <div className="flex items-center gap-1.5">
            <button
              className="text-[11px] px-2 py-1 h-[26px] rounded bg-[#252525] text-[#888] hover:text-[#ccc] cursor-pointer border-none font-mono leading-none"
              onClick={handleNewSession}
              title="New session"
            >
              new
            </button>
            <button
              className="text-[11px] px-2 py-1 h-[26px] rounded bg-[#252525] text-[#888] hover:text-[#ccc] cursor-pointer border-none font-mono leading-none"
              onClick={() => { if (!showSessions) loadSessions(); setShowSessions(s => !s) }}
              title="Previous sessions"
            >
              {showSessions ? 'close' : 'sessions'}
            </button>
            {streaming && <span className="text-[11px] text-status-warning animate-pulse font-mono">streaming</span>}
          </div>

          <div className="flex-1" />

          {/* Right: context & config */}
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
          {history.map((entry, i) => (
            entry.role === 'thinking' ? (
              showThinking && (
                <div key={i} className="px-4 py-2 border-l-2 border-[#444] ml-4 mr-4 my-1">
                  <div className="text-[10px] text-[#666] mb-1 uppercase tracking-wider">thinking</div>
                  <div className="text-[#888] text-xs whitespace-pre-wrap">{entry.text}</div>
                </div>
              )
            ) : (
            <div
              key={i}
              className={`px-4 py-2 whitespace-pre-wrap ${
                entry.role === 'user' ? 'text-accent' :
                entry.role === 'error' ? 'text-status-error' :
                entry.role === 'status' ? 'text-[#555]' :
                'text-[#e0e0e0]'
              }`}
            >
              {entry.role === 'user' && <span className="text-accent mr-2">#</span>}
              {entry.text}
              {entry.imageUrls && entry.imageUrls.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {entry.imageUrls.map((url, j) => (
                    <img key={j} src={url} alt="attachment" className="max-h-40 max-w-[240px] rounded border border-[#333] object-contain bg-[#1a1a1a]" />
                  ))}
                </div>
              )}
            </div>
            )
          ))}

          {/* Live thinking block during streaming */}
          {streaming && showThinking && thinkingBuffer && (
            <div className="px-4 py-2 border-l-2 border-[#444] ml-4 mr-4 my-1">
              <div className="text-[10px] text-[#666] mb-1 uppercase tracking-wider">thinking</div>
              <div className="text-[#888] text-xs whitespace-pre-wrap">{thinkingBuffer}</div>
            </div>
          )}

          {streaming && visibleStream && (
            <div className="px-4 py-2 text-[#e0e0e0] whitespace-pre-wrap">
              {visibleStream}
              {displayedLength >= streamBuffer.length && (
                <span className="text-accent animate-pulse">_</span>
              )}
            </div>
          )}
          {streaming && !visibleStream && (
            <div className="px-4 py-2 text-[#555] animate-pulse">thinking...</div>
          )}

          {/* Queued messages */}
          {messageQueue.length > 0 && (
            <div className="px-4 pb-1">
              {messageQueue.map((msg, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-[#888] font-mono py-0.5">
                  <span className="text-[#666]">{i + 1}.</span>
                  <span className="truncate flex-1">{msg}</span>
                  <button
                    className="text-[#666] hover:text-[#aaa] cursor-pointer border-none bg-transparent font-mono shrink-0"
                    onClick={() => {
                      const updated = messageQueue.filter((_, j) => j !== i)
                      messageQueueRef.current = updated
                      setMessageQueue(updated)
                    }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Pending images */}
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

          {/* Input line — always visible; queues when streaming */}
          <div className="flex items-center px-4 py-1.5">
            <span className={`shrink-0 mr-1 ${streaming ? 'text-[#555]' : 'text-accent'}`}>{streaming ? '>' : '#'}</span>
            <input
              ref={inputRef}
              type="text"
              className="flex-1 bg-transparent border-none outline-none text-[#e0e0e0] font-mono text-sm placeholder:text-[#444]"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
              }}
              onPaste={handlePaste}
              placeholder={streaming ? 'queue a message...' : claudeSessionId ? '' : 'type a message...'}
              autoFocus
            />
            {messageQueue.length > 0 && (
              <div className="flex items-center gap-1 ml-2 shrink-0">
                <span className="text-[10px] text-[#555] font-mono">{messageQueue.length} queued</span>
                <button
                  className="text-[10px] text-[#555] hover:text-[#888] cursor-pointer border-none bg-transparent font-mono"
                  onClick={() => { messageQueueRef.current = []; setMessageQueue([]) }}
                  title="Clear queue"
                >✕</button>
              </div>
            )}
          </div>

          {/* Status line */}
          <div className="flex items-center gap-3 px-4 py-1 border-t border-[#1e1e1e] shrink-0 text-[10px] text-[#444] font-mono">
            {claudeSessionId ? (
              <>
                <span className="text-[#555]">session</span>
                <span className="text-[#666]">{claudeSessionId.slice(0, 16)}…</span>
              </>
            ) : (
              <span>no session</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
