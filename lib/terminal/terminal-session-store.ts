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
  // Provider that originated this session. Session IDs are stored per-CLI
  // (codex rollouts ≠ claude sessions ≠ gemini threads), so follow-up turns
  // on the same claudeSessionId MUST run on the originating provider.
  sessionProvider: string | null
  // conversation
  history: TermEntry[]
  // live stream buffers
  streamBuffer: string
  thinkingBuffer: string
  rawBuffer: string  // accumulates non-JSON lines from passthrough streaming
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
  sessionProvider: null,
  history: [],
  streamBuffer: '',
  thinkingBuffer: '',
  rawBuffer: '',
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
  // Coalesce notifications across a frame. SSE token deltas arrive at hundreds
  // of events per second; without batching, every delta forces a full
  // <Markdown> re-render of the growing streamBuffer — O(n²) work that pegged
  // a renderer process at ~100% CPU. State writes still happen synchronously
  // (so reads via get() inside the same tick see the latest); only the
  // listener fan-out is deferred until the next animation frame.
  private pendingNotify = new Set<string>()
  private rafHandle: number | null = null
  private timerHandle: ReturnType<typeof setTimeout> | null = null
  // Separate flag from the handles: a synchronous rAF stub (used in tests)
  // fires the callback BEFORE rAF returns, so the assignment
  // `rafHandle = requestAnimationFrame(...)` would overwrite the null
  // that flushNotifications just set, leaving notify() to think a flush is
  // still pending and silently dropping subsequent notifications.
  private flushScheduled = false

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

  private flushNotifications = () => {
    this.flushScheduled = false
    this.rafHandle = null
    this.timerHandle = null
    const projects = Array.from(this.pendingNotify)
    this.pendingNotify.clear()
    for (const projectName of projects) {
      const set = this.listeners.get(projectName)
      if (!set) continue
      set.forEach((l) => {
        try {
          l()
        } catch {}
      })
    }
  }

  private notify(projectName: string) {
    this.pendingNotify.add(projectName)
    if (this.flushScheduled) return
    this.flushScheduled = true
    // rAF when visible (paint-aligned, ~60 fps cap). When hidden, fall back
    // to a coarser timeout so background tabs idle instead of running rAF
    // (browsers throttle rAF in background tabs but still wake us up).
    const hidden = typeof document !== 'undefined' && document.hidden
    if (!hidden && typeof requestAnimationFrame !== 'undefined') {
      const id = requestAnimationFrame(this.flushNotifications)
      // Only assign if the callback hasn't already cleared the flag
      // (synchronous rAF stub in tests).
      if (this.flushScheduled) this.rafHandle = id
    } else {
      const id = setTimeout(this.flushNotifications, hidden ? 250 : 16)
      if (this.flushScheduled) this.timerHandle = id
    }
  }

  // Test hook: synchronously flush any pending notifications. Production
  // callers should never need this — listeners fire on the next frame.
  __flushNotifications(): void {
    if (this.rafHandle !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle)
      this.timerHandle = null
    }
    if (this.flushScheduled) this.flushNotifications()
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
  // passthrough=true uses ?passthrough=1: non-JSON log lines → `raw` history entries,
  // NDJSON lines → parsed Claude events. Used for release logs.
  startStream(projectName: string, jobId: string, raw = false, passthrough = false): void {
    this.closeStream(projectName)
    this.update(projectName, () => ({
      currentJobId: jobId,
      streaming: true,
      streamIsRaw: raw,
      streamStartedAt: Date.now(),
      streamBuffer: '',
      thinkingBuffer: '',
      rawBuffer: '',
      streamTools: [],
      lastStats: null,
    }))

    const url = raw ? `/api/streaming/${jobId}?raw=1`
      : passthrough ? `/api/streaming/${jobId}?passthrough=1`
      : `/api/streaming/${jobId}`
    const es = new EventSource(url)
    this.esMap.set(projectName, es)

    // Flush rawBuffer to history — called when a non-raw event arrives so the
    // pending raw lines land in history *before* the new Claude content.
    const flushRaw = (s: SessionState): Partial<SessionState> => {
      if (!s.rawBuffer) return {}
      return {
        history: [...s.history, { role: 'raw' as const, text: s.rawBuffer }],
        rawBuffer: '',
      }
    }

    // Flush pending assistant/thinking/tool buffers to history — called when a
    // raw event arrives so the raw line lands *after* Claude content that
    // arrived before it. Without this, interleaved shell output in a passthrough
    // stream (e.g. release log) would render in the wrong order.
    const flushClaudeBuffers = (s: SessionState): Partial<SessionState> => {
      const entries: TermEntry[] = []
      if (s.thinkingBuffer) entries.push({ role: 'thinking', text: s.thinkingBuffer })
      for (const t of s.streamTools) entries.push({ role: 'tool', text: '', tool: t })
      if (s.streamBuffer) entries.push({ role: 'assistant', text: s.streamBuffer })
      if (entries.length === 0) return {}
      return {
        history: [...s.history, ...entries],
        streamBuffer: '',
        thinkingBuffer: '',
        streamTools: [],
      }
    }

    es.onmessage = (event) => {
      this.update(projectName, (s) => ({
        ...flushRaw(s),
        streamBuffer: s.streamBuffer + event.data,
      }))
    }

    es.addEventListener('raw', (event) => {
      const line = (event as MessageEvent).data
      this.update(projectName, (s) => ({
        ...flushClaudeBuffers(s),
        rawBuffer: s.rawBuffer + line + '\n',
      }))
    })

    es.addEventListener('thinking', (event) => {
      const data = (event as MessageEvent).data
      this.update(projectName, (s) => ({
        ...flushRaw(s),
        thinkingBuffer: s.thinkingBuffer + data,
      }))
    })

    es.addEventListener('compacting', () => {
      this.update(projectName, (s) => {
        const flushResult = flushClaudeBuffers(s)
        const baseHistory = flushResult.history ?? s.history
        return {
          ...flushResult,
          history: [...baseHistory, { role: 'status' as const, text: 'Compacting context…' }],
          streamBuffer: '',
        }
      })
    })

    es.addEventListener('tool_use', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        this.update(projectName, (s) => {
          const rawFlush = flushRaw(s)
          const baseHistory = rawFlush.history ?? s.history
          const flushHistory = s.streamBuffer
            ? [...baseHistory, { role: 'assistant' as const, text: s.streamBuffer }]
            : baseHistory
          const tool: ToolEntry = { name: data.name, input: data.input }
          return {
            ...rawFlush,
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
          const completed = { ...s.streamTools[s.streamTools.length - 1], result: data.content }
          const rest = s.streamTools.slice(0, -1)
          // Flush completed tool+result pair to history immediately so the
          // live streaming area only ever shows the currently-executing tool.
          return {
            history: [...s.history, { role: 'tool' as const, text: '', tool: completed }],
            streamTools: rest,
          }
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
        provider?: string | null;
      } = {}
      try {
        metadata = JSON.parse((event as MessageEvent).data)
      } catch {}
      this.closeStream(projectName)
      this.update(projectName, (s) => {
        const newEntries: TermEntry[] = []
        // Flush any remaining raw lines (from passthrough mode) before final Claude output
        if (s.rawBuffer) newEntries.push({ role: 'raw', text: s.rawBuffer })
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
          rawBuffer: '',
          streamTools: [],
          streaming: false,
          streamStartedAt: null,
          currentJobId: null,
          claudeSessionId: sid,
          sessionKey: sid ?? 'new',
          sessionProvider: metadata.provider ?? s.sessionProvider,
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
