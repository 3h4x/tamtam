import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  appendUniqueErrorDetail,
  buildTerminalEntriesFromJobLog,
  terminalExitEntry,
  terminalStore,
  type TermEntry,
  type SkillItem,
  type DocItem,
} from '@/lib/terminal/terminal-session-store'
import type { SessionItem } from './SessionsPanel'
import { hasPrerequisiteContext } from './prerequisite-context'
import {
  buildEntriesForCompletedJobs,
  contextItemsFromMeta,
  fetchSessionJobs,
  isRestorableSessionKind,
  retrievedContextEntryFromMeta,
  restoredPrompt,
} from './session-restore'

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
  model?: string | null
}

interface JobDetail {
  session_id?: string | null
  context_meta?: string | null
  provider?: string | null
  prompt?: string | null
  user_prompt?: string | null
  detail?: string | null
}

export function useSessionManager(projectName: string) {
  const router = useRouter()
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      // Ask the server for session-bearing rows only and cap to 100 — enough
      // to surface the 10 most-recent distinct sessions even when many rows
      // share a session_id (e.g. multi-step chats).
      const res = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}&has_session=1&limit=100`)
      const data = await res.json()
      // Drop the "(no prompt)" noise that used to bury the list: pipeline steps
      // and composed agent turns carry a session_id but no user-facing prompt,
      // so restoring them shows an empty conversation. Keep every restorable
      // session that has an actual prompt (user chats AND meaningful agent/issue
      // runs), which is what a "recent sessions" list should offer.
      const jobs: JobDict[] = (data.jobs ?? [])
        .filter((j: JobDict) => isRestorableSessionKind(j.kind) && j.session_id && !!restoredPrompt(j))
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
        // Prefer the first turn that actually carries a prompt so the row label
        // reflects what the conversation was about, not an empty follow-up.
        const promptJob = [...sameSession].reverse().find(o => restoredPrompt(o)) ?? earliest
        grouped.push({
          id: latest.id,
          prompt: restoredPrompt(promptJob),
          startedAt: latest.started_at,
          finishedAt: latest.finished_at,
          sessionId: latest.session_id,
          exitCode: latest.exit_code,
          ...(latest.model ? { model: latest.model } : {}),
          ...(latest.provider ? { provider: latest.provider } : {}),
        })
        if (grouped.length >= 10) break
      }
      setSessions(grouped)
    } catch {}
    setLoadingSessions(false)
  }, [projectName])

  const restoreSession = useCallback(async (session: SessionItem) => {
    if (session.sessionId) {
      if (terminalStore.get(projectName).claudeSessionId !== session.sessionId) {
        terminalStore.reset(projectName)
      }
      try {
        const jobs = await fetchSessionJobs(projectName, session.sessionId)
        const matches = jobs
          .filter(j => isRestorableSessionKind(j.kind))
          .sort((a, b) => a.started_at - b.started_at)
        if (matches.length > 0) {
          const firstMatch = matches[0]
          const sessionProvider = matches.find(m => typeof m.provider === 'string' && m.provider)?.provider ?? null
          const { skills: loadedSkills, docs: loadedDocs } = contextItemsFromMeta(firstMatch.context_meta)
          const lastMatch = matches[matches.length - 1]
          const lastIsRunning = lastMatch.status !== 'done' && lastMatch.finished_at === null
          const completedMatches = lastIsRunning ? matches.slice(0, -1) : matches
          const entries = await buildEntriesForCompletedJobs(completedMatches)
          router.replace(`/project/${encodeURIComponent(projectName)}/terminal/${encodeURIComponent(session.sessionId)}`)
          if (lastIsRunning) {
            const retrievedContextEntry = retrievedContextEntryFromMeta(lastMatch.context_meta)
            if (retrievedContextEntry) entries.push(retrievedContextEntry)
            const prompt = restoredPrompt(lastMatch)
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
      let prompt = session.prompt
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(session.id)}`)
        const data = await res.json() as JobDetail
        passthrough = hasPrerequisiteContext(data.context_meta)
        liveSessionId = data.session_id ?? liveSessionId
        sessionProvider = data.provider ?? null
        prompt = data.user_prompt || data.prompt || prompt
      } catch {}
      terminalStore.reset(projectName)
      terminalStore.update(projectName, () => ({
        claudeSessionId: liveSessionId,
        sessionKey: liveSessionId || 'new',
        sessionProvider,
        history: prompt ? [{ role: 'user', text: prompt }] : [],
      }))
      terminalStore.startStream(projectName, session.id, false, passthrough)
      return
    }
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(session.id)}`)
      const data = await res.json() as JobDetail & { exit_code?: number | null; log?: string | null; log_pruned?: boolean }
      const entries: TermEntry[] = []
      const prompt = data.user_prompt || data.prompt || session.prompt
      const retrievedContextEntry = retrievedContextEntryFromMeta(data.context_meta)
      if (retrievedContextEntry) entries.push(retrievedContextEntry)
      if (prompt) entries.push({ role: 'user', text: prompt })
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
          const providerLabel = data.provider ? `${data.provider} run failed` : 'provider run failed'
          entries.push({ role: 'error', text: providerLabel })
          entries.push(...buildTerminalEntriesFromJobLog(data.log, {
            passthrough: hasPrerequisiteContext(data.context_meta),
            fallbackRole: 'error',
          }))
          appendUniqueErrorDetail(entries, data.detail)
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
        appendUniqueErrorDetail(entries, data.detail)
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
