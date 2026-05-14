import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  buildTerminalEntriesFromJobLog,
  terminalExitEntry,
  terminalStore,
  type TermEntry,
  type SkillItem,
  type DocItem,
} from '@/lib/terminal/terminal-session-store'
import type { SessionItem } from './SessionsPanel'
import { hasPrerequisiteContext } from './prerequisite-context'

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
  provider?: string | null
}

interface JobDetail {
  session_id?: string | null
  context_meta?: string | null
  provider?: string | null
}

export function useSessionManager(projectName: string) {
  const router = useRouter()
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const isSessionKind = (k: string) =>
    k === 'run' || ['review', 'fix', 'fix-ci'].includes(k) || k.startsWith('agent:')

  const loadSessions = async () => {
    setLoadingSessions(true)
    try {
      // Ask the server for session-bearing rows only and cap to 50 — enough
      // to surface the 5 most-recent distinct sessions even when many rows
      // share a session_id (e.g. multi-step chats).
      const res = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}&has_session=1&limit=50`)
      const data = await res.json()
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
    if (session.sessionId) {
      if (terminalStore.get(projectName).claudeSessionId !== session.sessionId) {
        terminalStore.reset(projectName)
      }
      try {
        // Server-side filter to this exact session_id — avoids fetching the
        // full project history just to find the half-dozen rows that share
        // the session.
        const listRes = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}&session_id=${encodeURIComponent(session.sessionId)}&limit=200`)
        const listData = await listRes.json()
        const jobs: JobDict[] = listData.jobs ?? []
        const matches = jobs
          .filter(j => isSessionKind(j.kind))
          .sort((a, b) => a.started_at - b.started_at)
        if (matches.length > 0) {
          const firstMatch = matches[0]
          const sessionProvider = matches.find(m => typeof m.provider === 'string' && m.provider)?.provider ?? null
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
            const log = jobEntry?.log
            const exitCode = typeof jobEntry?.exit_code === 'number' ? jobEntry.exit_code : m.exit_code
            const exitEntry = exitCode !== null && exitCode !== undefined
              ? terminalExitEntry(exitCode)
              : null
            if (log) {
              if (exitEntry?.text === 'cancelled') {
                entries.push(...buildTerminalEntriesFromJobLog(log, {
                  passthrough: hasPrerequisiteContext(m.context_meta),
                }))
                entries.push(exitEntry)
              } else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
                entries.push({ role: 'error', text: 'claude run failed' })
                entries.push(...buildTerminalEntriesFromJobLog(log, {
                  passthrough: hasPrerequisiteContext(m.context_meta),
                  fallbackRole: 'error',
                }))
              } else {
                entries.push(...buildTerminalEntriesFromJobLog(log, {
                  passthrough: hasPrerequisiteContext(m.context_meta),
                }))
              }
            } else if (jobEntry?.log_pruned) {
              entries.push({ role: 'status', text: 'Log file deleted by retention policy' })
              if (exitEntry) {
                entries.push(exitEntry)
              }
            } else if (exitEntry && exitCode !== 0) {
              entries.push(exitEntry)
            }
          })
          router.replace(`/project/${projectName}/terminal/${session.sessionId}`)
          if (lastIsRunning) {
            const prompt = lastMatch.user_prompt || lastMatch.prompt
            if (prompt) entries.push({ role: 'user', text: prompt })
            terminalStore.update(projectName, () => ({
              history: entries,
              claudeSessionId: session.sessionId,
              sessionKey: session.sessionId!,
              sessionProvider,
              selectedItems: loadedSkills,
              selectedDocs: loadedDocs,
              restoredFor: session.sessionId,
            }))
            terminalStore.startStream(
              projectName,
              lastMatch.id,
              false,
              hasPrerequisiteContext(lastMatch.context_meta),
            )
          } else {
            terminalStore.update(projectName, () => ({
              history: entries,
              claudeSessionId: session.sessionId,
              sessionKey: session.sessionId!,
              sessionProvider,
              selectedItems: loadedSkills,
              selectedDocs: loadedDocs,
              restoredFor: session.sessionId,
            }))
          }
          return
        }
      } catch {}
    }

    // Fallback: single-job restore
    const isStillRunning = session.finishedAt === null && session.exitCode === null
    if (isStillRunning) {
      let passthrough = false
      let liveSessionId = session.sessionId
      let sessionProvider: string | null = null
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(session.id)}`)
        const data = await res.json() as JobDetail
        passthrough = hasPrerequisiteContext(data.context_meta)
        liveSessionId = data.session_id ?? liveSessionId
        sessionProvider = data.provider ?? null
      } catch {}
      terminalStore.reset(projectName)
      terminalStore.update(projectName, () => ({
        claudeSessionId: liveSessionId,
        sessionKey: liveSessionId || 'new',
        sessionProvider,
        history: session.prompt ? [{ role: 'user', text: session.prompt }] : [],
      }))
      terminalStore.startStream(projectName, session.id, false, passthrough)
      return
    }
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(session.id)}`)
      const data = await res.json()
      const entries: TermEntry[] = []
      if (session.prompt) entries.push({ role: 'user', text: session.prompt })
      const exitCode = typeof data.exit_code === 'number' ? data.exit_code : session.exitCode
      const exitEntry = exitCode !== null && exitCode !== undefined
        ? terminalExitEntry(exitCode)
        : null
      if (data.log) {
        if (exitEntry?.text === 'cancelled') {
          entries.push(...buildTerminalEntriesFromJobLog(data.log, {
            passthrough: hasPrerequisiteContext(data.context_meta),
          }))
          entries.push(exitEntry)
        } else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
          entries.push({ role: 'error', text: 'claude run failed' })
          entries.push(...buildTerminalEntriesFromJobLog(data.log, {
            passthrough: hasPrerequisiteContext(data.context_meta),
            fallbackRole: 'error',
          }))
        } else {
          entries.push(...buildTerminalEntriesFromJobLog(data.log, {
            passthrough: hasPrerequisiteContext(data.context_meta),
          }))
        }
      } else if (data.log_pruned) {
        entries.push({ role: 'status', text: 'Log file deleted by retention policy' })
        if (exitEntry) {
          entries.push(exitEntry)
        }
      } else if (exitEntry && exitCode !== 0) {
        entries.push(exitEntry)
      }
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
        sessionProvider: data.provider ?? null,
        selectedItems: loadedSkills,
        selectedDocs: loadedDocs,
      }))
    } catch {}
  }, [router, projectName])

  return { sessions, loadingSessions, loadSessions, restoreSession }
}
