'use client'

export interface SessionItem {
  id: string
  prompt: string | null
  startedAt: number
  finishedAt: number | null
  sessionId: string | null
  exitCode: number | null
}

interface SessionsPanelProps {
  sessions: SessionItem[]
  loadingSessions: boolean
  onRestore: (session: SessionItem) => void
}

export function SessionsPanel({ sessions, loadingSessions, onRestore }: SessionsPanelProps) {
  // Hoist `now` so every session in this render computes its relative age
  // against the same instant — otherwise two sessions one second apart could
  // render the same `timeAgo` (or different ones, depending on map timing).
  const nowSec = Date.now() / 1000
  return (
    <div className="border-b border-border bg-bg-secondary shrink-0">
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
        <div className="px-4 py-3 text-xs text-text-tertiary font-mono">no recent sessions</div>
      ) : (
        sessions.map(session => {
          const isRunning = session.finishedAt === null && session.exitCode === null
          const isSuccess = session.exitCode === 0
          const isFailed = session.exitCode !== null && session.exitCode !== 0
          const prompt = session.prompt
            ? session.prompt.length > 80 ? session.prompt.slice(0, 80) + '…' : session.prompt
            : '(no prompt)'
          const secs = Math.floor(nowSec - session.startedAt)
          const timeAgo = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`
          const dotClass = isRunning ? 'bg-status-warning animate-pulse' : isSuccess ? 'bg-status-success' : isFailed ? 'bg-status-error' : 'bg-text-tertiary'
          const dotTitle = isRunning ? 'running' : isSuccess ? 'done' : isFailed ? `exit ${session.exitCode}` : 'unknown'
          return (
            <button
              key={session.id}
              className="flex items-center gap-3 w-full px-4 py-2 text-left hover:bg-bg-tertiary border-none bg-transparent border-b border-border/50 last:border-b-0 cursor-pointer"
              onClick={() => onRestore(session)}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} title={dotTitle} />
              <span className="text-xs text-text-primary font-mono truncate flex-1">{prompt}</span>
              <span className="text-xs text-text-tertiary font-mono shrink-0">{timeAgo}</span>
            </button>
          )
        })
      )}
    </div>
  )
}
