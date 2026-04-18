// Module-level store for terminal session state. Survives component unmounts
// so switching tabs or navigating away does not drop live streams or history.

export interface ToolEntry {
  name: string
  input?: string
  result?: string
  collapsed?: boolean
}

export interface TermEntry {
  role: 'user' | 'assistant' | 'status' | 'error' | 'thinking' | 'tool' | 'raw'
  text: string
  imageUrls?: string[]
  tool?: ToolEntry
}

export interface SkillItem {
  id: string
  name: string
  description: string
  content?: string
  source: 'db' | 'file'
}

export interface DocItem {
  name: string
  content: string
}

export interface RunStats {
  duration: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
}

export interface SessionState {
  // identity
  sessionKey: string // claudeSessionId or 'new'
  claudeSessionId: string | null
  currentJobId: string | null
  // conversation
  history: TermEntry[]
  // live stream buffers
  streamBuffer: string
  thinkingBuffer: string
  streamTools: ToolEntry[]
  streaming: boolean
  streamIsRaw: boolean
  streamStartedAt: number | null
  // meta
  lastStats: RunStats | null
  messageQueue: string[]
  selectedItems: SkillItem[]
  selectedDocs: DocItem[]
  pendingAutoSubmit: string | null
  // hydration
  restoredFor: string | null // sessionId this state was loaded for
}

const emptyState = (): SessionState => ({
  sessionKey: 'new',
  claudeSessionId: null,
  currentJobId: null,
  history: [],
  streamBuffer: '',
  thinkingBuffer: '',
  streamTools: [],
  streaming: false,
  streamIsRaw: false,
  streamStartedAt: null,
  lastStats: null,
  messageQueue: [],
  selectedItems: [],
  selectedDocs: [],
  pendingAutoSubmit: null,
  restoredFor: null,
})

type Listener = () => void

class TerminalStore {
  private states = new Map<string, SessionState>()
  private esMap = new Map<string, EventSource>()
  private listeners = new Map<string, Set<Listener>>()

  get(projectName: string): SessionState {
    let s = this.states.get(projectName)
    if (!s) {
      s = emptyState()
      this.states.set(projectName, s)
    }
    return s
  }

  subscribe(projectName: string, listener: Listener): () => void {
    let set = this.listeners.get(projectName)
    if (!set) {
      set = new Set()
      this.listeners.set(projectName, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
    }
  }

  private notify(projectName: string) {
    const set = this.listeners.get(projectName)
    if (!set) return
    set.forEach((l) => {
      try {
        l()
      } catch {}
    })
  }

  update(projectName: string, updater: (s: SessionState) => Partial<SessionState> | void): void {
    const prev = this.get(projectName)
    const patch = updater(prev)
    const next = patch ? { ...prev, ...patch } : prev
    this.states.set(projectName, next)
    this.notify(projectName)
  }

  replace(projectName: string, next: SessionState): void {
    this.states.set(projectName, next)
    this.notify(projectName)
  }

  reset(projectName: string): void {
    this.closeStream(projectName)
    this.replace(projectName, emptyState())
  }

  closeStream(projectName: string): void {
    const es = this.esMap.get(projectName)
    if (es) {
      try {
        es.close()
      } catch {}
      this.esMap.delete(projectName)
    }
  }

  hasStream(projectName: string): boolean {
    return this.esMap.has(projectName)
  }

  // Start streaming a jobId. Closes any prior stream for this project.
  startStream(projectName: string, jobId: string, raw = false): void {
    this.closeStream(projectName)
    this.update(projectName, () => ({
      currentJobId: jobId,
      streaming: true,
      streamIsRaw: raw,
      streamStartedAt: Date.now(),
      streamBuffer: '',
      thinkingBuffer: '',
      streamTools: [],
      lastStats: null,
    }))

    const url = raw ? `/api/streaming/${jobId}?raw=1` : `/api/streaming/${jobId}`
    const es = new EventSource(url)
    this.esMap.set(projectName, es)

    es.onmessage = (event) => {
      this.update(projectName, (s) => ({ streamBuffer: s.streamBuffer + event.data }))
    }

    es.addEventListener('thinking', (event) => {
      const data = (event as MessageEvent).data
      this.update(projectName, (s) => ({ thinkingBuffer: s.thinkingBuffer + data }))
    })

    es.addEventListener('tool_use', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        this.update(projectName, (s) => {
          const flushHistory = s.streamBuffer
            ? [...s.history, { role: 'assistant' as const, text: s.streamBuffer }]
            : s.history
          const tool: ToolEntry = { name: data.name, input: data.input }
          return {
            history: flushHistory,
            streamBuffer: '',
            streamTools: [...s.streamTools, tool],
          }
        })
      } catch {}
    })

    es.addEventListener('tool_result', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        this.update(projectName, (s) => {
          if (s.streamTools.length === 0) return {}
          const last = { ...s.streamTools[s.streamTools.length - 1], result: data.content }
          return { streamTools: [...s.streamTools.slice(0, -1), last] }
        })
      } catch {}
    })

    es.addEventListener('done', (event) => {
      let metadata: {
        exitCode?: number | null;
        sessionId?: string | null;
        detail?: string;
        error?: boolean;
        errorText?: string;
        duration?: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreateTokens?: number;
      } = {}
      try {
        metadata = JSON.parse((event as MessageEvent).data)
      } catch {}
      this.closeStream(projectName)
      this.update(projectName, (s) => {
        const newEntries: TermEntry[] = []
        if (s.thinkingBuffer) newEntries.push({ role: 'thinking', text: s.thinkingBuffer })
        for (const t of s.streamTools) newEntries.push({ role: 'tool', text: '', tool: t })
        if (s.streamBuffer) newEntries.push({ role: 'assistant', text: s.streamBuffer })
        // Parser-emitted done events carry `error` (from is_error) and
        // optionally `errorText` (the result string Claude returned, e.g.
        // "API Error: Stream idle timeout…"). Server-synthesized done events
        // carry `exitCode` and `detail` instead. Show whichever is present.
        if (metadata.error) {
          newEntries.push({ role: 'error', text: 'claude run failed' })
          if (metadata.errorText) {
            newEntries.push({ role: 'error', text: metadata.errorText })
          }
        } else if (metadata.exitCode !== undefined && metadata.exitCode !== null) {
          const ok = metadata.exitCode === 0
          newEntries.push({
            role: ok ? 'status' : 'error',
            text: ok ? 'exit 0 — ok' : `exit ${metadata.exitCode}`,
          })
          if (!ok && typeof metadata.detail === 'string' && metadata.detail) {
            newEntries.push({ role: 'error', text: metadata.detail })
          }
        }
        const sid = metadata.sessionId || s.claudeSessionId || null
        const stats: RunStats | null =
          typeof metadata.duration === 'number' || typeof metadata.inputTokens === 'number'
            ? {
                duration: metadata.duration ?? 0,
                inputTokens: metadata.inputTokens ?? 0,
                outputTokens: metadata.outputTokens ?? 0,
                cacheReadTokens: metadata.cacheReadTokens ?? 0,
                cacheCreateTokens: metadata.cacheCreateTokens ?? 0,
              }
            : s.lastStats
        // Sync URL to the latest session ID (Claude may rotate between turns)
        if (sid && typeof window !== 'undefined') {
          const target = `/project/${projectName}/terminal/${sid}`
          if (window.location.pathname !== target) {
            window.history.replaceState(null, '', target)
          }
        }
        // Dequeue next message if any
        let pendingAutoSubmit = s.pendingAutoSubmit
        let messageQueue = s.messageQueue
        if (s.messageQueue.length > 0) {
          const [next, ...rest] = s.messageQueue
          pendingAutoSubmit = next
          messageQueue = rest
        }
        return {
          history: [...s.history, ...newEntries],
          streamBuffer: '',
          thinkingBuffer: '',
          streamTools: [],
          streaming: false,
          streamStartedAt: null,
          currentJobId: null,
          claudeSessionId: sid,
          sessionKey: sid ?? 'new',
          lastStats: stats,
          pendingAutoSubmit,
          messageQueue,
        }
      })
    })

    es.onerror = () => {
      this.closeStream(projectName)
      this.update(projectName, (s) => {
        const newEntries: TermEntry[] = []
        if (s.thinkingBuffer) newEntries.push({ role: 'thinking', text: s.thinkingBuffer })
        for (const t of s.streamTools) newEntries.push({ role: 'tool', text: '', tool: t })
        if (s.streamBuffer) newEntries.push({ role: 'assistant', text: s.streamBuffer })
        if (newEntries.length === 0) newEntries.push({ role: 'error', text: 'Connection error' })
        return {
          history: [...s.history, ...newEntries],
          streamBuffer: '',
          thinkingBuffer: '',
          streamTools: [],
          streaming: false,
          streamStartedAt: null,
          currentJobId: null,
          messageQueue: [],
          pendingAutoSubmit: null,
        }
      })
    }
  }

  cancelStream(projectName: string): string | null {
    const s = this.get(projectName)
    const jobId = s.currentJobId
    this.closeStream(projectName)
    this.update(projectName, (st) => {
      const entries: TermEntry[] = []
      if (st.streamBuffer) entries.push({ role: 'assistant', text: st.streamBuffer })
      entries.push({ role: 'error', text: 'cancelled' })
      return {
        history: [...st.history, ...entries],
        streamBuffer: '',
        thinkingBuffer: '',
        streamTools: [],
        streaming: false,
        streamStartedAt: null,
        currentJobId: null,
        messageQueue: [],
        pendingAutoSubmit: null,
      }
    })
    return jobId
  }

  clearPendingAutoSubmit(projectName: string): void {
    this.update(projectName, () => ({ pendingAutoSubmit: null }))
  }
}

export const terminalStore = new TerminalStore()
