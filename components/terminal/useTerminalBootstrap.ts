import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  terminalExitEntry,
  terminalStore,
  type TermEntry,
  type SkillItem,
  type DocItem,
} from '@/lib/terminal/terminal-session-store'
import { isClaudeJobKind } from '../TerminalTab'

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
  provider: string | null
}

interface BootstrapParams {
  projectName: string
  initialSessionId: string | undefined
  jobParam: string | null
  promptParam: string | null
  issueNumberParam: string | null
  issueTitleParam: string | null
  resumeSessionIdParam: string | null
  resumeProviderParam?: string | null
  onLoadSessions: () => void
}

export function useTerminalBootstrap({
  projectName,
  initialSessionId,
  jobParam,
  promptParam,
  issueNumberParam,
  issueTitleParam,
  resumeSessionIdParam,
  resumeProviderParam,
  onLoadSessions,
}: BootstrapParams) {
  const router = useRouter()
  const [currentReleaseId, setCurrentReleaseId] = useState<string | null>(null)
  const attachedExternalJobRef = useRef<string | null>(null)

  // Preload sessions on fresh terminal landing (no session/job param)
  useEffect(() => {
    if (initialSessionId || jobParam) return
    onLoadSessions()
  }, [])

  // Auto-submit prompt from ?prompt= query param (e.g. opened from Issues tab).
  useEffect(() => {
    if (!promptParam || initialSessionId || jobParam) return
    const submit = promptParam
    const run = async () => {
      if (issueNumberParam) {
        let branchOk = true
        let branchErr = ''
        try {
          const r = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/issue-branch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              issue_number: Number(issueNumberParam),
              issue_title: issueTitleParam ?? '',
            }),
          })
          if (!r.ok) {
            branchOk = false
            try { branchErr = (await r.json())?.detail ?? r.statusText } catch { branchErr = r.statusText }
          }
        } catch (e) {
          branchOk = false
          branchErr = e instanceof Error ? e.message : 'network error'
        }
        if (!branchOk) {
          terminalStore.update(projectName, (s) => ({
            history: [
              ...s.history,
              {
                role: 'error',
                text: `Could not check out the issue branch: ${branchErr}\n\nResolve the underlying problem (commit / stash / rm conflicting files) and click Continue again. Auto-submit aborted so edits don't land on the wrong branch.`,
              },
            ],
          }))
          router.replace(`/project/${projectName}/terminal`)
          return
        }
        terminalStore.reset(projectName)
      }
      if (resumeSessionIdParam) {
        terminalStore.update(projectName, () => ({
          claudeSessionId: resumeSessionIdParam,
          sessionProvider: resumeProviderParam ?? null,
        }))
      }
      terminalStore.update(projectName, () => ({ pendingAutoSubmit: submit }))
      router.replace(`/project/${projectName}/terminal`)
    }
    run()
  }, [])

  // Restore session from URL param.
  useEffect(() => {
    if (!initialSessionId) return
    const cur = terminalStore.get(projectName)
    // Only bail out if the currently-streaming job is for the same session
    // we're being asked to restore. If a different agent run was streaming
    // when the URL changed, close that stream and restore the requested
    // session — otherwise the user clicks a review and keeps seeing the
    // unrelated running agent.
    if (cur.streaming && cur.claudeSessionId === initialSessionId) return
    if (cur.streaming) {
      terminalStore.closeStream(projectName)
      terminalStore.reset(projectName)
    }

    let cancelled = false
    const run = async () => {
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
          const exitCode = typeof jobEntry?.exit_code === 'number' ? jobEntry.exit_code : m.exit_code
          const exitEntry = exitCode !== null && exitCode !== undefined
            ? terminalExitEntry(exitCode)
            : null
          if (jobEntry?.log) {
            if (exitEntry?.text === 'cancelled') {
              entries.push({ role: 'assistant', text: jobEntry.log })
              entries.push(exitEntry)
            } else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
              entries.push({ role: 'error', text: 'claude run failed' })
              entries.push({ role: 'error', text: jobEntry.log })
            } else {
              entries.push({ role: 'assistant', text: jobEntry.log })
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

        const sessionProvider = matches.find(m => m.provider)?.provider ?? null
        if (lastIsRunning) {
          const prompt = lastMatch.user_prompt || lastMatch.prompt
          if (prompt) entries.push({ role: 'user', text: prompt })
          terminalStore.update(projectName, () => ({
            history: entries,
            claudeSessionId: initialSessionId,
            sessionKey: initialSessionId,
            sessionProvider,
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
            sessionProvider,
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
        if (data.session_id && data.kind !== 'release') {
          router.replace(`/project/${projectName}/terminal/${data.session_id}`)
          return
        }
        setCurrentReleaseId(data.release_id ?? null)
        const entries: TermEntry[] = []
        const kind = data.kind || jobParam.split('-').slice(1, -1).join('-')
        const isClaudeJob = isClaudeJobKind(data.kind)
        const startedAtSec = typeof data.started_at === 'number' ? data.started_at : null
        const startedLabel = startedAtSec
          ? new Date(startedAtSec * 1000).toLocaleString(undefined, {
              month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit', second: '2-digit',
              hour12: false,
            })
          : null
        entries.push({ role: 'status', text: startedLabel ? `${kind} · ${startedLabel}` : kind })

        const jobPrompt = data.user_prompt || data.prompt
        if (jobPrompt) {
          entries.push({ role: 'user', text: jobPrompt })
        }

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

        terminalStore.reset(projectName)

        if (isClaudeJob) {
          terminalStore.update(projectName, () => ({ history: entries }))
          terminalStore.startStream(projectName, jobParam)
        } else if (data.log_pruned) {
          entries.push({ role: 'status', text: 'Log file deleted by retention policy' })
          const exitCode = data.exit_code
          if (exitCode !== undefined && exitCode !== null) {
            entries.push(terminalExitEntry(exitCode))
          }
          terminalStore.update(projectName, () => ({ history: entries }))
        } else {
          terminalStore.update(projectName, () => ({ history: entries }))
          terminalStore.startStream(projectName, jobParam, false, true)
        }
      } catch {}
    }
    loadJob()
  }, [jobParam, initialSessionId, projectName])

  // Fresh terminal landing pages should attach to newly-started release jobs
  // so the operator sees the live pipeline without manually refreshing.
  // Do not hijack the interactive terminal for unrelated `run` / `agent:*`
  // jobs that started elsewhere.
  useEffect(() => {
    if (initialSessionId || jobParam) return
    let cancelled = false

    const poll = async () => {
      const cur = terminalStore.get(projectName)
      if (
        cur.streaming ||
        cur.currentJobId ||
        cur.history.length > 0 ||
        cur.pendingAutoSubmit
      ) return
      try {
        const res = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}`)
        if (!res.ok) return
        const data = await res.json()
        const runningJobs: JobDict[] = (data.jobs ?? [])
          .filter((job: JobDict) => job.status === 'running')
          .sort((a: JobDict, b: JobDict) => b.started_at - a.started_at)
        const target = runningJobs.find((job: JobDict) => job.kind === 'release')
        if (!target || attachedExternalJobRef.current === target.id) return
        attachedExternalJobRef.current = target.id
        router.replace(`/project/${projectName}/terminal?job=${encodeURIComponent(target.id)}`)
      } catch {}
    }

    poll()
    const id = setInterval(() => {
      if (!cancelled) void poll()
    }, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [initialSessionId, jobParam, projectName, router])

  return { currentReleaseId }
}
