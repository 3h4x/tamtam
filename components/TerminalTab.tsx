'use client'

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { runProject, fetchSkills, fetchPersonas } from '@/lib/client-api'
import type { Skill, Persona } from '@/lib/client-api'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderAnsi, hasAnsi } from '@/lib/ansi-render'
import {
  terminalStore,
  type ToolEntry,
  type TermEntry,
  type SkillItem,
  type DocItem,
} from '@/lib/terminal-session-store'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'

// Exported for unit testing — determines whether a job kind uses Claude's
// stream-json output format (parsed path) vs raw log output.
// Notably EXCLUDES `release`: the release log is an aggregation of child logs
// (plain test output + NDJSON review + plain commit/push), so stream-json
// parsing would silently drop every non-NDJSON line. Render it raw so the
// user sees the full aggregated pipeline output.
export function isClaudeJobKind(kind: string | undefined): boolean {
  return ['run', 'review', 'fix', 'fix-ci', 'fix-push'].includes(kind ?? '') ||
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

interface JobDict {
  id: string
  kind: string
  status: string
  session_id: string | null
  started_at: number
  finished_at: number | null
  exit_code: number | null
  user_prompt: string | null
  prompt: string | null
  context_meta: string | null
}

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

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|heic|heif|avif)$/i

// Collapse carriage-return progress updates (e.g. docker pull) by keeping
// only the content after the last `\r` on each logical line. Without this,
// every intermediate progress frame shows up as separate text.
function collapseCarriageReturns(text: string): string {
  return text.split('\n').map(line => {
    const idx = line.lastIndexOf('\r')
    return idx >= 0 ? line.slice(idx + 1) : line
  }).join('\n')
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

function ToolBlock({ tool, executing }: { tool: ToolEntry; executing?: boolean }) {
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
        className={`flex items-center gap-2 px-2 py-0.5 rounded-sm leading-tight ${clickable ? 'cursor-pointer hover:bg-[#181818]' : ''}`}
        onClick={() => clickable && setCollapsed(!collapsed)}
      >
        {executing && !hasResult && (
          <span className="w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse shrink-0" />
        )}
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
  const promptParam = searchParams.get('prompt')
  const issueNumberParam = searchParams.get('issue_number')
  const issueRepoParam = searchParams.get('issue_repo')
  const issueTitleParam = searchParams.get('issue_title')

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
  // Issue context captured from URL params — only used on the first submission of a new session
  const issueContextRef = useRef<{ number: number; repo: string; title: string } | null>(
    issueNumberParam ? { number: Number(issueNumberParam), repo: issueRepoParam ?? '', title: issueTitleParam ?? '' } : null
  )
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [currentReleaseId, setCurrentReleaseId] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [idleSec, setIdleSec] = useState(0)
  const lastActivityRef = useRef<number>(Date.now())
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

  // Auto-submit prompt from ?prompt= query param (e.g. opened from Issues tab).
  // When issue params are present, provision the feature branch BEFORE handing
  // off to Claude — otherwise interim edits land on the default branch.
  useEffect(() => {
    if (!promptParam || initialSessionId || jobParam) return
    const submit = promptParam
    const run = async () => {
      if (issueNumberParam) {
        try {
          await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/issue-branch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              issue_number: Number(issueNumberParam),
              issue_title: issueTitleParam ?? '',
            }),
          })
        } catch {}
        // When "Work on issue N" arrives, clear any leftover terminal session
        // for this project. Otherwise a stale `claudeSessionId` makes the
        // auto-submit look like a follow-up message — the `!sessionId` guard
        // below drops `issueContextRef`, the run job is stamped without
        // `gh_issue_number`, and the downstream commit/push pipeline can't
        // find the issue → branch never gets committed to → no PR.
        terminalStore.reset(projectName)
      }
      terminalStore.update(projectName, () => ({ pendingAutoSubmit: submit }))
      router.replace(`/project/${projectName}/terminal`)
    }
    run()
  }, [])

  // Restore session from URL param. Skipped if store already holds state for
  // this sessionId — preserves live streams and in-memory outputs across
  // unmounts / tab navigations.
  useEffect(() => {
    if (!initialSessionId) return
    const cur = terminalStore.get(projectName)
    // Never wipe a live stream — user is watching output right now.
    if (cur.streaming) return

    let cancelled = false
    const run = async () => {
      // If history already reflects this session AND has content, only
      // re-fetch if the DB now holds more turns than we rendered (follow-ups
      // submitted since the last restore must become visible).
      if (cur.restoredFor === initialSessionId && cur.history.length > 0) {
        const userEntries = cur.history.filter(h => h.role === 'user').length
        try {
          const listRes = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}`)
          const listData = await listRes.json()
          const dbMatches = (listData.jobs ?? []).filter(
            (j: JobDict) => j.session_id === initialSessionId
              && (['run', 'review', 'fix', 'fix-ci'].includes(j.kind) || j.kind.startsWith('agent:'))
          ).length
          if (dbMatches <= userEntries) return
        } catch {
          return
        }
      }

      if (cancelled) return
      await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}`)
      .then(r => r.json())
      .then(async (data) => {
        const jobs: JobDict[] = data.jobs ?? []
        // Sessions can be created by 'run', 'review', 'fix', 'fix-ci', or agent kinds
        const isSessionKind = (k: string) =>
          ['run', 'review', 'fix', 'fix-ci'].includes(k) || k.startsWith('agent:')
        const matches = jobs
          .filter(j => j.session_id === initialSessionId && isSessionKind(j.kind))
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
          const jobEntry = logData[i]
          if (jobEntry?.log) {
            entries.push({ role: 'assistant', text: jobEntry.log })
          } else if (jobEntry?.log_pruned) {
            entries.push({ role: 'status', text: 'Log file deleted by retention policy' })
          }
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
    }
    run()
    return () => { cancelled = true }
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
        // If this job has a session_id, promote to the session URL so the
        // restore path sets claudeSessionId — follow-up chats then resume the
        // session and group with the original run (agent/review/fix/etc.)
        // instead of starting a brand-new thread.
        // Release jobs may have a leaked session_id from a child in their
        // aggregated log — never promote; we want the raw release log, not
        // the session-grouped view of some embedded child.
        if (data.session_id && data.kind !== 'release') {
          router.replace(`/project/${projectName}/terminal/${data.session_id}`)
          return
        }
        // Track the release this job belongs to (for the trace link in the header)
        setCurrentReleaseId(data.release_id ?? null)
        const entries: TermEntry[] = []
        const kind = data.kind || jobParam.split('-').slice(1, -1).join('-')
        // `fix-push` spawns Claude directly, so its log is pure stream-json
        // and takes the parsed path. `release` is deliberately excluded from
        // isClaudeJobKind: its log is an aggregate of child logs (plain test
        // output + NDJSON review + plain commit/push), and stream-json parsing
        // would silently drop every non-NDJSON section — render it raw instead.
        const isClaudeJob = isClaudeJobKind(data.kind)
        // Stamp the "# kind" header with the start time so the user can see
        // when each section of a multi-step release kicked off. Applies to
        // every job kind that renders in the terminal — release, test,
        // review, fix, commit, push, agent runs.
        const startedAtSec = typeof data.started_at === 'number' ? data.started_at : null
        const startedLabel = startedAtSec
          ? new Date(startedAtSec * 1000).toLocaleString(undefined, {
              month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit', second: '2-digit',
              hour12: false,
            })
          : null
        entries.push({ role: 'status', text: startedLabel ? `${kind} · ${startedLabel}` : kind })

        // Show the prompt that was sent so the user can see what kicked off the run
        // (especially important for agent runs with a custom prompt).
        const jobPrompt = data.user_prompt || data.prompt
        if (jobPrompt) {
          entries.push({ role: 'user', text: jobPrompt })
        }

        // Populate toolbar chips from contextMeta if the job recorded them (agents do this).
        if (data.context_meta) {
          try {
            const meta = JSON.parse(data.context_meta)
            if (Array.isArray(meta.skills)) {
              terminalStore.update(projectName, () => ({ selectedItems: meta.skills }))
            }
            if (Array.isArray(meta.docs)) {
              terminalStore.update(projectName, () => ({ selectedDocs: meta.docs }))
            }
          } catch {}
        }

        // Loading a fresh job into the terminal — drop any lingering session
        // state from a previous run. Otherwise a follow-up message in this
        // terminal resumes the OLD session (with stale context) instead of
        // chatting against the new job's log.
        terminalStore.reset(projectName)

        if (isClaudeJob) {
          terminalStore.update(projectName, () => ({ history: entries }))
          terminalStore.startStream(projectName, jobParam)
        } else if (data.log_pruned) {
          // Log was deleted — show what we know statically
          entries.push({ role: 'status', text: 'Log file deleted by retention policy' })
          const exitCode = data.exit_code
          if (exitCode !== undefined && exitCode !== null) {
            const ok = exitCode === 0
            entries.push({ role: ok ? 'status' : 'error', text: ok ? 'exit 0 — ok' : `exit ${exitCode}` })
          }
          terminalStore.update(projectName, () => ({ history: entries }))
        } else {
          // Running or finished non-Claude job (release, test, push, commit):
          // use passthrough streaming so non-JSON lines render as monospace and
          // NDJSON sections (e.g. review) render as parsed Claude output.
          terminalStore.update(projectName, () => ({ history: entries }))
          terminalStore.startStream(projectName, jobParam, false, true)
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

  // Spinner animation during streaming. Pause when the tab is hidden — a 12 Hz
  // re-render loop in a background tab burns ~100% CPU on a renderer process
  // doing nothing visible.
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

  // Live elapsed timer during streaming, anchored to store's streamStartedAt
  // so it survives unmount/remount.
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
    // Fallback for drags from apps (e.g. macOS Preview) that put entries in `items`
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

  const removeImage = useCallback((idx: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== idx))
    setPendingImageUrls(prev => prev.filter((_, i) => i !== idx))
  }, [])

  // Auto-submit dequeued message after streaming ends.
  // Guarded by a ref so React StrictMode's double-invoke in dev doesn't fire
  // two submits for the same pending text (which creates duplicate run jobs).
  const autoSubmittedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!shouldFireAutoSubmit(streaming, pendingAutoSubmit, autoSubmittedRef.current)) return
    autoSubmittedRef.current = pendingAutoSubmit
    const text = pendingAutoSubmit!
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

      // Always prepend currently-selected skills/docs so the toolbar badges
      // reflect reality. Follow-up messages that add a new doc mid-session
      // need the content sent too — users rightly expect "if it's in the bar,
      // it's in context."
      const dbSkills = selectedItems.filter(s => s.source === 'db' && s.content)
      if (dbSkills.length > 0) {
        const skillContext = dbSkills.map(s => `## ${s.name}\n${s.content}`).join('\n\n---\n\n')
        fullPrompt = skillContext + '\n\n---\n\n' + fullPrompt
      }
      if (selectedDocs.length > 0) {
        const docContext = selectedDocs.map(d => `## ${d.name}\n${d.content}`).join('\n\n---\n\n')
        fullPrompt = docContext + '\n\n---\n\n' + fullPrompt
      }

      // Personas (file-path skills) are re-sent on every turn so the toolbar
      // badges match reality. The server reads the file each time — cheap.
      const personaPaths = selectedItems
        .filter(s => s.source === 'file')
        .map(s => s.id.replace('persona:', ''))

      // contextMeta snapshots the selection at session creation for restore.
      const contextMetaStr = !isFollowUp
        ? JSON.stringify({
            skills: selectedItems.map(s => ({ id: s.id, name: s.name, description: s.description, content: s.content, source: s.source })),
            docs: selectedDocs.map(d => ({ name: d.name, content: d.content })),
          })
        : undefined

      // If the terminal is viewing an open release/push/fix-push/test job,
      // prepend that job's log as context so Claude knows exactly what just
      // failed and can act on it — no manual paste required.
      if (!isFollowUp && cur.currentJobId) {
        const inspectableKinds = ['release', 'push', 'fix-push', 'test', 'review', 'fix', 'fix-ci']
        const jobKindFromId = inspectableKinds.find(k => cur.currentJobId!.includes(`-${k}-`))
        if (jobKindFromId) {
          try {
            const logRes = await fetch(`/api/jobs/${encodeURIComponent(cur.currentJobId)}/logs`)
            if (logRes.ok) {
              const logData = await logRes.json()
              const rawLog: string = typeof logData.content === 'string' ? logData.content : ''
              if (rawLog.trim()) {
                const tail = rawLog.length > 12000 ? '...(truncated)...\n' + rawLog.slice(-12000) : rawLog
                fullPrompt = `## Previous session output (${jobKindFromId} job, for context)\n\n\`\`\`\n${tail}\n\`\`\`\n\n---\n\n${fullPrompt}`
              }
            }
          } catch {
            // Best-effort — if the fetch fails, just send the prompt as-is.
          }
        }
      }

      const issueCtx = !sessionId ? issueContextRef.current : null
      const result = await runProject(projectName, fullPrompt, {
        files: imageFiles.length > 0 ? imageFiles : undefined,
        personas: personaPaths.length > 0 ? personaPaths : undefined,
        model,
        resumeSessionId: sessionId || undefined,
        contextMeta: contextMetaStr,
        userPrompt: text,
        ghIssueNumber: issueCtx?.number ?? undefined,
        ghIssueRepo: issueCtx?.repo ?? undefined,
        ghIssueTitle: issueCtx?.title ?? undefined,
      })
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
      const isSessionKind = (k: string) =>
        k === 'run' || k.startsWith('agent:')
      const jobs: JobDict[] = (data.jobs ?? [])
        .filter((j: JobDict) => isSessionKind(j.kind) && j.session_id)
        .sort((a: JobDict, b: JobDict) => b.started_at - a.started_at)

      const seen = new Set<string>()
      const grouped: SessionItem[] = []
      for (const j of jobs) {
        const key = j.session_id!
        if (seen.has(key)) continue
        seen.add(key)
        const sameSession = jobs.filter(o => o.session_id === key)
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
        if (grouped.length >= 5) break
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
        const jobs: JobDict[] = listData.jobs ?? []
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
              title="Recent sessions"
            >
              {showSessions ? 'close' : 'recent'}
              {!showSessions && sessions.some(s => s.finishedAt === null && s.exitCode === null) && (
                <span className="ml-0.5 text-status-warning text-[10px]">●</span>
              )}
            </button>
            {streaming && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-warning/20 text-status-warning font-mono leading-none flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse" />
                live
              </span>
            )}
            {currentReleaseId && (
              <Link
                href={`/project/${encodeURIComponent(projectName)}/release/${encodeURIComponent(currentReleaseId)}`}
                className="text-[11px] px-2 py-1 h-[26px] rounded bg-[#252525] text-accent hover:text-accent/80 font-mono leading-none flex items-center"
                title="View unified release trace"
              >
                trace ↗
              </Link>
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
            {(() => {
              const allSelected = [
                ...selectedItems.map(i => ({ label: i.name, remove: () => toggleItem(i), key: `s:${i.id}` })),
                ...selectedDocs.map(d => ({ label: d.name, remove: () => toggleDoc(d), key: `d:${d.name}` })),
              ]
              const SHOW = 3
              const visible = allSelected.slice(0, SHOW)
              const overflow = allSelected.length - SHOW
              return (
                <>
                  {visible.map(item => (
                    <span key={item.key} className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono gap-0.5 max-w-[100px]">
                      <span className="truncate">{item.label}</span>
                      <button className="text-accent/40 hover:text-accent cursor-pointer border-none bg-transparent leading-none shrink-0" onClick={item.remove} title={`Remove ${item.label}`}>×</button>
                    </span>
                  ))}
                  {overflow > 0 && (
                    <span
                      className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent/70 font-mono cursor-pointer hover:bg-accent/20"
                      title={allSelected.slice(SHOW).map(i => i.label).join(', ')}
                      onClick={() => setShowSkillPicker(true)}
                    >
                      +{overflow} more
                    </span>
                  )}
                </>
              )
            })()}
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

        {/* Sessions panel — last 5 resumable sessions */}
        {showSessions && (
          <div className="border-b border-[#2a2a2a] bg-[#151515] shrink-0">
            {loadingSessions ? (
              <div className="px-4 py-2 flex flex-col gap-1.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2" style={{ opacity: 1 - i * 0.25 }}>
                    <div className="skeleton h-3 w-3 rounded-full shrink-0" />
                    <div className="skeleton h-3 w-28" />
                    <div className="skeleton h-3 w-16 ml-auto" />
                  </div>
                ))}
              </div>
            ) : sessions.length === 0 ? (
              <div className="px-4 py-3 text-xs text-[#555] font-mono">no recent sessions</div>
            ) : (
              sessions.map(session => {
                const isRunning = session.finishedAt === null && session.exitCode === null
                const isSuccess = session.exitCode === 0
                const prompt = session.prompt
                  ? session.prompt.length > 80 ? session.prompt.slice(0, 80) + '…' : session.prompt
                  : '(no prompt)'
                const secs = Math.floor(Date.now() / 1000 - session.startedAt)
                const timeAgo = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`
                return (
                  <button
                    key={session.id}
                    className="flex items-center gap-3 w-full px-4 py-2 text-left hover:bg-[#1e1e1e] border-none bg-transparent border-b border-[#1d1d1d] last:border-b-0 cursor-pointer"
                    onClick={() => restoreSession(session)}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isRunning ? 'bg-status-warning animate-pulse' : isSuccess ? 'bg-status-success' : 'bg-[#555]'}`} />
                    <span className="text-xs text-[#bbb] font-mono truncate flex-1">{prompt}</span>
                    <span className="text-[10px] text-[#555] font-mono shrink-0">{timeAgo}</span>
                  </button>
                )
              })
            )}
          </div>
        )}

        {/* Terminal body — scrollable only */}
        <div
          ref={termRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto font-mono text-sm flex flex-col min-h-0"
        >

          {/* Empty state */}
          {history.length === 0 && !streaming && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 select-none py-16">
              <span className="text-2xl font-mono text-[#222]">_</span>
              <span className="text-sm font-mono text-[#2a2a2a]">start a conversation</span>
            </div>
          )}

          {history.map((entry, i) => (
            entry.role === 'thinking' ? (
              showThinking && (
                <div key={i} className="px-4 py-2 border-l-2 border-accent/20 ml-4 mr-4 my-1">
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
                entry.role === 'user' ? 'text-[#f0f0f0] whitespace-pre-wrap border-l-2 border-accent/40' :
                entry.role === 'error' ? 'text-status-error whitespace-pre-wrap border-l-2 border-status-error/50 bg-status-error/5' :
                entry.role === 'status' ? 'text-[#555] whitespace-pre-wrap text-xs italic' :
                entry.role === 'raw' ? 'text-[#c0c0c0] font-mono text-xs whitespace-pre-wrap' :
                'text-[#e0e0e0] terminal-markdown'
              }`}
            >
              {entry.role === 'user' && <span className="text-accent mr-2">#</span>}
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
            <div className="px-4 py-2 text-[#c0c0c0] font-mono text-xs whitespace-pre-wrap">
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
            <div className="px-4 py-2 border-l-2 border-accent/20 ml-4 mr-4 my-1">
              <div className="text-[10px] text-[#666] mb-1 uppercase tracking-wider">thinking</div>
              <div className="text-[#888] text-xs whitespace-pre-wrap">{thinkingBuffer}</div>
            </div>
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
            const label = pendingTool
              ? `running ${pendingTool.name}…`
              : (lastStreamLine || 'thinking…')
            const idleLabel = idleSec >= 5 ? ` · idle ${idleSec}s` : ''
            return (
              <div className="px-4 py-2 flex items-center gap-2">
                <span className="text-accent font-mono text-sm">{spinnerChars[spinnerFrame % spinnerChars.length]}</span>
                <span className="text-status-warning text-xs font-mono shrink-0">{(elapsedMs / 1000).toFixed(1)}s</span>
                <span className={`text-xs font-mono truncate flex-1 ${pendingTool ? 'text-status-warning' : 'text-[#666]'}`}>
                  {label}{idleLabel}
                </span>
                <button
                  className="text-[10px] px-1.5 py-0.5 rounded bg-status-error/20 text-status-error hover:bg-status-error/40 cursor-pointer border-none font-mono leading-none shrink-0"
                  onClick={handleCancel}
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
                    onClick={() => setMessageQueue(prev => prev.filter((_, j) => j !== i))}
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
                  onClick={() => { setPendingImages([]); setPendingImageUrls([]) }}
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
                        onClick={(e) => { e.stopPropagation(); removeImage(i) }}
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
        </div>
      </div>
  )
}
