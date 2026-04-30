import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { terminalStore, type TermEntry, type SkillItem, type DocItem } from '@/lib/terminal/terminal-session-store'
import type { SessionItem } from './SessionsPanel'

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

export function useSessionManager(projectName: string) {
  const router = useRouter()
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)

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

    // Fallback: single-job restore
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

  return { sessions, loadingSessions, loadSessions, restoreSession }
}
