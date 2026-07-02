// Module-level store for terminal session state. Survives component unmounts
// so switching tabs or navigating away does not drop live streams or history.

import { createParseState, parseStreamLines } from '@/lib/jobs/claude-stream-parser'
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes'

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
  streamHistoryBaseLength: number | null
  // meta
  lastStats: RunStats | null
  messageQueue: string[]
  selectedItems: SkillItem[]
  selectedDocs: DocItem[]
  pendingAutoSubmit: string | null
  // error surface: populated on `done` when is_error=true. Drives the
  // banner-with-resume above the input. `kind: 'internal-cli'` triggers
  // a one-shot auto-retry (e.g. ede_diagnostic races) before the user
  // sees the banner; subsequent errors during that same auto-retry stop
  // retrying so we don't mask real problems.
  lastError: {
    text: string
    kind: 'internal-cli' | 'other'
    autoRetryUsed: boolean
    sessionId: string | null
  } | null
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
  streamHistoryBaseLength: null,
  lastStats: null,
  messageQueue: [],
  selectedItems: [],
  selectedDocs: [],
  pendingAutoSubmit: null,
  lastError: null,
  restoredFor: null,
})

type Listener = () => void

type RecoveredBuffers = Pick<SessionState, 'history' | 'streamBuffer' | 'thinkingBuffer' | 'rawBuffer' | 'streamTools'> & {
  usedPlainTextFallback: boolean
}

interface BuildTerminalEntriesOptions {
  passthrough?: boolean
  fallbackRole?: Extract<TermEntry['role'], 'assistant' | 'error'>
}

export function terminalExitEntry(exitCode: number): Pick<TermEntry, 'role' | 'text'> {
  if (exitCode === 0) return { role: 'status', text: 'exit 0 — ok' }
  if (isCancelledExitCode(exitCode)) return { role: 'error', text: 'cancelled' }
  return { role: 'error', text: `exit ${exitCode}` }
}

function humanizeCancelledRawLine(line: string): string {
  return line.replace(
    /^(# .*?finished) — exit -(2|3) — /,
    '$1 — cancelled — ',
  )
}

function humanizeCancelledRawLog(log: string): string {
  return log
    .split('\n')
    .map(humanizeCancelledRawLine)
    .join('\n')
}

export function appendUniqueErrorDetail(
  entries: TermEntry[],
  detail: string | null | undefined,
  fromIndex = 0,
): void {
  const trimmed = detail?.trim()
  if (!trimmed) return
  if (entries.slice(fromIndex).some((entry) => entry.text.trim() === trimmed)) return
  entries.push({ role: 'error', text: detail! })
}

function hasEntryText(entries: TermEntry[], detail: string | null | undefined): boolean {
  const trimmed = detail?.trim()
  return !!trimmed && entries.some((entry) => entry.text.trim() === trimmed)
}

function emptyRecoveredBuffers(): RecoveredBuffers {
  return {
    history: [],
    streamBuffer: '',
    thinkingBuffer: '',
    rawBuffer: '',
    streamTools: [],
    usedPlainTextFallback: false,
  }
}

function appendParsedEventsToBuffers(
  log: string,
  passthrough: boolean,
): RecoveredBuffers {
  const history: TermEntry[] = []
  let streamBuffer = ''
  let thinkingBuffer = ''
  let rawBuffer = ''
  let streamTools: ToolEntry[] = []
  let sawParsedEvent = false
  let usedPlainTextFallback = false

  const markParsed = () => {
    sawParsedEvent = true
  }

  const flushRaw = () => {
    if (!rawBuffer) return
    history.push({ role: 'raw', text: rawBuffer })
    rawBuffer = ''
  }

  const flushClaudeBuffers = () => {
    if (thinkingBuffer) history.push({ role: 'thinking', text: thinkingBuffer })
    for (const tool of streamTools) history.push({ role: 'tool', text: '', tool })
    if (streamBuffer) history.push({ role: 'assistant', text: streamBuffer })
    thinkingBuffer = ''
    streamTools = []
    streamBuffer = ''
  }

  const events = parseStreamLines(log, {
    state: createParseState(),
    onRawLine: passthrough
      ? (line) => {
          flushClaudeBuffers()
          rawBuffer += `${humanizeCancelledRawLine(line)}\n`
        }
      : undefined,
  })

  for (const event of events) {
    if (event.type === 'text') {
      markParsed()
      flushRaw()
      streamBuffer += event.text
      continue
    }
    if (event.type === 'thinking') {
      markParsed()
      flushRaw()
      thinkingBuffer += event.text
      continue
    }
    if (event.type === 'tool_use') {
      markParsed()
      flushRaw()
      if (streamBuffer) {
        history.push({ role: 'assistant', text: streamBuffer })
        streamBuffer = ''
      }
      streamTools = [...streamTools, { name: event.name, input: event.input }]
      continue
    }
    if (event.type === 'tool_result') {
      markParsed()
      if (streamTools.length === 0) continue
      const completed = { ...streamTools[streamTools.length - 1], result: event.content }
      history.push({ role: 'tool', text: '', tool: completed })
      streamTools = streamTools.slice(0, -1)
      continue
    }
    if (event.type === 'compacting') {
      markParsed()
      flushClaudeBuffers()
      history.push({ role: 'status', text: 'Compacting context…' })
      continue
    }
    if (event.type === 'done') {
      markParsed()
    }
  }

  if (!passthrough && !sawParsedEvent && log.trim()) {
    streamBuffer = log
    usedPlainTextFallback = true
  }

  return {
    history,
    streamBuffer,
    thinkingBuffer,
    rawBuffer,
    streamTools,
    usedPlainTextFallback,
  }
}

function rebuildRecoveredBuffers(log: string, raw: boolean, passthrough: boolean): RecoveredBuffers {
  if (!log) return emptyRecoveredBuffers()
  const normalizedLog = humanizeCancelledRawLog(log)

  if (raw) {
    return {
      history: [],
      streamBuffer: '',
      thinkingBuffer: '',
      rawBuffer: normalizedLog,
      streamTools: [],
      usedPlainTextFallback: false,
    }
  }

  return appendParsedEventsToBuffers(normalizedLog, passthrough)
}

function resolvedFallbackRole(
  recovered: RecoveredBuffers,
  fallbackRole: Extract<TermEntry['role'], 'assistant' | 'error'>,
): Extract<TermEntry['role'], 'assistant' | 'error'> {
  return recovered.usedPlainTextFallback ? fallbackRole : 'assistant'
}

export function buildTerminalEntriesFromJobLog(log: string, options: BuildTerminalEntriesOptions | boolean = false): TermEntry[] {
  const normalized = typeof options === 'boolean'
    ? { passthrough: options, fallbackRole: 'assistant' as const }
    : { passthrough: options.passthrough ?? false, fallbackRole: options.fallbackRole ?? 'assistant' as const }
  const recovered = rebuildRecoveredBuffers(log, false, normalized.passthrough)
  const entries: TermEntry[] = [...recovered.history]
  if (recovered.rawBuffer) entries.push({ role: 'raw', text: recovered.rawBuffer })
  if (recovered.thinkingBuffer) entries.push({ role: 'thinking', text: recovered.thinkingBuffer })
  for (const tool of recovered.streamTools) entries.push({ role: 'tool', text: '', tool })
  if (recovered.streamBuffer) {
    entries.push({ role: resolvedFallbackRole(recovered, normalized.fallbackRole), text: recovered.streamBuffer })
  }
  return entries
}

class TerminalStore {
  private states = new Map<string, SessionState>()
  private esMap = new Map<string, EventSource>()
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private recoveryStartedAt = new Map<string, number>()
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
    this.stopRecovery(projectName)
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

  private stopRecovery(projectName: string): void {
    const timer = this.recoveryTimers.get(projectName)
    if (timer) {
      clearTimeout(timer)
      this.recoveryTimers.delete(projectName)
    }
    this.recoveryStartedAt.delete(projectName)
  }

  private scheduleRecovery(
    projectName: string,
    jobId: string,
    raw: boolean,
    passthrough: boolean,
    delayMs: number,
  ): void {
    const existing = this.recoveryTimers.get(projectName)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(projectName)
      void this.recoverStream(projectName, jobId, raw, passthrough)
    }, delayMs)
    this.recoveryTimers.set(projectName, timer)
  }

  private finalizeRecoveredStream(
    projectName: string,
    jobId: string,
    payload: Record<string, unknown>,
    raw: boolean,
    passthrough: boolean,
  ): void {
    this.stopRecovery(projectName)
    this.update(projectName, (s) => {
      if (s.currentJobId !== jobId || !s.streaming) return {}
      const baseLength = s.streamHistoryBaseLength ?? s.history.length
      const baseHistory = s.history.slice(0, baseLength)
      const log = typeof payload.log === 'string' ? payload.log : ''
      const recovered = rebuildRecoveredBuffers(log, raw, passthrough)
      const newEntries: TermEntry[] = [...baseHistory, ...recovered.history]
      if (recovered.rawBuffer) newEntries.push({ role: 'raw', text: recovered.rawBuffer })
      if (recovered.thinkingBuffer) newEntries.push({ role: 'thinking', text: recovered.thinkingBuffer })
      for (const tool of recovered.streamTools) newEntries.push({ role: 'tool', text: '', tool })
      const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : null
      if (recovered.streamBuffer) {
        // The stream buffer is the assistant's output — render it as assistant,
        // not as an error, even when the exit code is non-zero. Claude CLI is
        // frequently SIGKILLed by pm2's timeout AFTER emitting its final result
        // (a clean finish that markDone later rewrites to exit 0), so keying the
        // content's role off the raw exit code painted normal replies red. Run
        // status is already conveyed by the separate `terminalExitEntry` below.
        newEntries.push({ role: resolvedFallbackRole(recovered, 'assistant'), text: recovered.streamBuffer })
      }
      if (exitCode !== null) {
        // Mirror markDone's is_error override client-side: a non-zero exit that
        // follows a clean stream-json result is pm2's post-result SIGKILL, not a
        // failure — so don't render a red "exit -1" marker or an error detail for
        // what was logically a successful run. Genuine failures (plain-text
        // fallback / cancellation) keep their error marker.
        const cleanFinish = !!recovered.streamBuffer && !recovered.usedPlainTextFallback
        const effectiveExit = exitCode !== 0 && !isCancelledExitCode(exitCode) && cleanFinish ? 0 : exitCode
        newEntries.push(terminalExitEntry(effectiveExit))
        if (effectiveExit !== 0) {
          appendUniqueErrorDetail(newEntries, typeof payload.detail === 'string' ? payload.detail : null, baseHistory.length)
        }
      }
      let pendingAutoSubmit = s.pendingAutoSubmit
      let messageQueue = s.messageQueue
      if (s.messageQueue.length > 0) {
        const [next, ...rest] = s.messageQueue
        pendingAutoSubmit = next
        messageQueue = rest
      }
      const sid = typeof payload.session_id === 'string' && payload.session_id
        ? payload.session_id
        : s.claudeSessionId
      const stats: RunStats | null =
        typeof payload.duration_ms === 'number' || typeof payload.input_tokens === 'number'
          ? {
              duration: typeof payload.duration_ms === 'number' ? payload.duration_ms : 0,
              inputTokens: typeof payload.input_tokens === 'number' ? payload.input_tokens : 0,
              outputTokens: typeof payload.output_tokens === 'number' ? payload.output_tokens : 0,
              cacheReadTokens: typeof payload.cache_read_tokens === 'number' ? payload.cache_read_tokens : 0,
              cacheCreateTokens: typeof payload.cache_create_tokens === 'number' ? payload.cache_create_tokens : 0,
            }
          : s.lastStats
      if (sid && typeof window !== 'undefined') {
        const target = `/project/${encodeURIComponent(projectName)}/terminal/${encodeURIComponent(sid)}`
        if (window.location.pathname !== target) {
          window.history.replaceState(null, '', target)
        }
      }
      return {
        history: newEntries,
        streamBuffer: '',
        thinkingBuffer: '',
        rawBuffer: '',
        streamTools: [],
        streaming: false,
        streamStartedAt: null,
        streamHistoryBaseLength: null,
        currentJobId: null,
        claudeSessionId: sid ?? null,
        sessionKey: sid ?? 'new',
        sessionProvider: typeof payload.provider === 'string' ? payload.provider : s.sessionProvider,
        lastStats: stats,
        pendingAutoSubmit,
        messageQueue,
        restoredFor: sid ?? s.restoredFor,
      }
    })
  }

  private async hydrateFinalDetail(
    projectName: string,
    jobId: string,
    expectedSessionKey: string,
    expectedHistory: TermEntry[],
  ): Promise<void> {
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`)
      if (!response.ok) return
      const payload = await response.json() as { detail?: string | null }
      const detail = payload.detail
      if (!detail) return
      this.update(projectName, (s) => {
        if (s.history !== expectedHistory) return {}
        if (s.currentJobId !== null || s.streaming || s.sessionKey !== expectedSessionKey) return {}
        if (hasEntryText(s.history, detail)) return {}
        return {
          history: [...s.history, { role: 'error' as const, text: detail }],
        }
      })
    } catch {}
  }

  private async recoverStream(
    projectName: string,
    jobId: string,
    raw: boolean,
    passthrough: boolean,
  ): Promise<void> {
    const state = this.get(projectName)
    if (!state.streaming || state.currentJobId !== jobId) {
      this.stopRecovery(projectName)
      return
    }
    if (!this.recoveryStartedAt.has(projectName)) {
      this.recoveryStartedAt.set(projectName, Date.now())
    }
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`)
      if (!response.ok) throw new Error(`job probe failed: ${response.status}`)
      const payload = await response.json() as Record<string, unknown>
      this.update(projectName, (s) => {
        if (s.currentJobId !== jobId || !s.streaming) return {}
        const log = typeof payload.log === 'string' ? payload.log : ''
        const baseLength = s.streamHistoryBaseLength ?? s.history.length
        const baseHistory = s.history.slice(0, baseLength)
        const recovered = rebuildRecoveredBuffers(log, raw, passthrough)
        return {
          history: [...baseHistory, ...recovered.history],
          streamBuffer: recovered.streamBuffer,
          thinkingBuffer: recovered.thinkingBuffer,
          rawBuffer: recovered.rawBuffer,
          streamTools: recovered.streamTools,
        }
      })
      const finished = payload.finished_at !== null && payload.finished_at !== undefined
      const status = typeof payload.status === 'string' ? payload.status : null
      if (finished || status === 'done' || status === 'aborted') {
        this.finalizeRecoveredStream(projectName, jobId, payload, raw, passthrough)
        return
      }
      this.scheduleRecovery(projectName, jobId, raw, passthrough, 1000)
    } catch {
      const startedAt = this.recoveryStartedAt.get(projectName) ?? Date.now()
      if (Date.now() - startedAt >= 30_000) {
        this.stopRecovery(projectName)
        this.update(projectName, (s) => {
          if (s.currentJobId !== jobId || !s.streaming) return {}
          const baseLength = s.streamHistoryBaseLength ?? s.history.length
          const baseHistory = s.history.slice(0, baseLength)
          const entries: TermEntry[] = [...baseHistory]
          if (s.rawBuffer) entries.push({ role: 'raw', text: s.rawBuffer })
          if (s.thinkingBuffer) entries.push({ role: 'thinking', text: s.thinkingBuffer })
          for (const t of s.streamTools) entries.push({ role: 'tool', text: '', tool: t })
          if (s.streamBuffer) entries.push({ role: 'assistant', text: s.streamBuffer })
          entries.push({ role: 'status', text: 'Stream disconnected while the app was unavailable. Refresh to resume when the server is back.' })
          return {
            history: entries,
            streamBuffer: '',
            thinkingBuffer: '',
            rawBuffer: '',
            streamTools: [],
            streaming: false,
            streamStartedAt: null,
            streamHistoryBaseLength: null,
            currentJobId: null,
          }
        })
        return
      }
      this.scheduleRecovery(projectName, jobId, raw, passthrough, 1000)
    }
  }

  // Start streaming a jobId. Closes any prior stream for this project.
  // passthrough=true uses ?passthrough=1: non-JSON log lines → `raw` history entries,
  // NDJSON lines → parsed Claude events. Used for release logs.
  startStream(projectName: string, jobId: string, raw = false, passthrough = false): void {
    this.stopRecovery(projectName)
    this.closeStream(projectName)
    this.update(projectName, () => ({
      currentJobId: jobId,
      streaming: true,
      streamIsRaw: raw,
      streamStartedAt: Date.now(),
      streamHistoryBaseLength: this.get(projectName).history.length,
      streamBuffer: '',
      thinkingBuffer: '',
      rawBuffer: '',
      streamTools: [],
      lastStats: null,
    }))

    const encodedJobId = encodeURIComponent(jobId)
    const url = raw ? `/api/streaming/${encodedJobId}?raw=1`
      : passthrough ? `/api/streaming/${encodedJobId}?passthrough=1`
      : `/api/streaming/${encodedJobId}`
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
        rawBuffer: s.rawBuffer + humanizeCancelledRawLine(line) + '\n',
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
        errorKind?: 'internal-cli' | 'other';
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
        //
        // Errors also populate `lastError` (drives the resume banner) and,
        // for the retryable `internal-cli` kind, trigger a one-shot auto-
        // resume by re-queuing the most recent user prompt.
        let nextLastError = s.lastError
        let autoResumeText: string | null = null
        if (metadata.error) {
          const providerLabel = metadata.provider ? `${metadata.provider} run failed` : 'provider run failed'
          newEntries.push({ role: 'error', text: providerLabel })
          if (metadata.errorText) {
            newEntries.push({ role: 'error', text: metadata.errorText })
          }
          const errorKind = metadata.errorKind ?? 'other'
          const lastUserText = [...s.history].reverse().find((e) => e.role === 'user')?.text ?? null
          const priorAutoRetry = s.lastError?.autoRetryUsed ?? false
          const canAutoRetry =
            errorKind === 'internal-cli' &&
            !priorAutoRetry &&
            !!lastUserText &&
            !!(metadata.sessionId || s.claudeSessionId)
          nextLastError = {
            text: metadata.errorText || `${providerLabel} (no diagnostic emitted)`,
            kind: errorKind,
            autoRetryUsed: priorAutoRetry || canAutoRetry,
            sessionId: metadata.sessionId || s.claudeSessionId || null,
          }
          if (canAutoRetry && lastUserText) {
            autoResumeText = lastUserText
            newEntries.push({
              role: 'status',
              text: 'Internal CLI error · auto-resuming the same prompt once',
            })
          }
        } else if (metadata.exitCode !== undefined && metadata.exitCode !== null) {
          const ok = metadata.exitCode === 0
          newEntries.push(terminalExitEntry(metadata.exitCode))
          if (!ok) appendUniqueErrorDetail(newEntries, metadata.detail)
          if (ok) nextLastError = null
        } else {
          // No metadata.error and no exitCode — treat as clean end; clear
          // any stale error from a prior turn on the same session.
          nextLastError = null
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
          const target = `/project/${encodeURIComponent(projectName)}/terminal/${encodeURIComponent(sid)}`
          if (window.location.pathname !== target) {
            window.history.replaceState(null, '', target)
          }
        }
        // Dequeue next message if any. Auto-resume after an internal-CLI
        // error takes precedence over the user's queued messages — the
        // failed turn must finish before we move on.
        let pendingAutoSubmit = s.pendingAutoSubmit
        let messageQueue = s.messageQueue
        if (autoResumeText) {
          pendingAutoSubmit = autoResumeText
        } else if (s.messageQueue.length > 0) {
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
          streamHistoryBaseLength: null,
          currentJobId: null,
          claudeSessionId: sid,
          sessionKey: sid ?? 'new',
          sessionProvider: metadata.provider ?? s.sessionProvider,
          lastStats: stats,
          lastError: nextLastError,
          pendingAutoSubmit,
          messageQueue,
          restoredFor: sid ?? s.restoredFor,
        }
      })
      if (metadata.exitCode !== undefined && metadata.exitCode !== null && metadata.exitCode !== 0) {
        const finalized = this.get(projectName)
        void this.hydrateFinalDetail(projectName, jobId, finalized.sessionKey, finalized.history)
      }
    })

    es.onerror = () => {
      this.closeStream(projectName)
      this.scheduleRecovery(projectName, jobId, raw, passthrough, 1000)
    }
  }

  cancelStream(projectName: string): string | null {
    const s = this.get(projectName)
    const jobId = s.currentJobId
    this.stopRecovery(projectName)
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
        streamHistoryBaseLength: null,
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
