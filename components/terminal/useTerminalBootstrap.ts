import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  terminalExitEntry,
  terminalStore,
  type TermEntry,
} from '@/lib/terminal/terminal-session-store'
import { isClaudeJobKind } from '../TerminalTab'
import { hasPrerequisiteContext } from './prerequisite-context'
import {
  buildEntriesForCompletedJobs,
  contextItemsFromMeta,
  countSessionJobs,
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
  provider: string | null
  work_summary: string | null
}

function landingAutoAttachHref(projectName: string, job: JobDict): string | null {
  if (job.status !== 'running') return null
  if (job.kind === 'release') {
    return `/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(job.id)}`
  }
  if (job.kind === 'run') {
    if (job.session_id) {
      return `/project/${encodeURIComponent(projectName)}/terminal/${encodeURIComponent(job.session_id)}`
    }
    return `/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(job.id)}`
  }
  return null
}

function shouldRedirectJobParamToSession(data: Partial<JobDict>): data is Partial<JobDict> & { session_id: string } {
  if (!data.session_id || !isRestorableSessionKind(data.kind ?? '')) return false
  if (data.kind === 'run') return true
  return data.status !== 'running' || data.finished_at !== null || data.exit_code !== null
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
  const attachedSessionJobRef = useRef<string | null>(null)
  // One-shot redirect to the currently-running session on initial mount.
  // If you bookmark / open a stale session URL while another session is
  // live, you almost always want the live one. We only do this once per
  // mount so subsequent navigation (Sessions panel → old session) sticks.
  const runningRedirectChecked = useRef(false)

  // Preload sessions on fresh terminal landing (no session/job param)
  useEffect(() => {
    if (initialSessionId || jobParam) return
    onLoadSessions()
  }, [])

  // Mount-time: if the project has a running claude session that's not the
  // one in the URL, swap to it. Skips when ?job= is in play (notification
  // deep-links) — those want the specific job, not the latest running one.
  useEffect(() => {
    if (runningRedirectChecked.current) return
    if (jobParam) return
    runningRedirectChecked.current = true
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}&status=running&limit=20`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        const jobs: JobDict[] = data.jobs ?? []
        // Restorable session kinds only — release meta-jobs and other
        // non-claude rows don't have a tail-able session id we can land on.
        const live = jobs
          .filter((j) => j.session_id && isClaudeJobKind(j.kind) && j.finished_at === null)
          .sort((a, b) => b.started_at - a.started_at)[0]
        if (!live || !live.session_id) return
        if (initialSessionId && live.session_id === initialSessionId) return
        router.replace(`/project/${encodeURIComponent(projectName)}/terminal/${encodeURIComponent(live.session_id)}`)
      } catch {}
    })()
    return () => { cancelled = true }
  // Mount-only by design — depend only on projectName so a project switch
  // re-arms the check; subsequent in-page navigation stays put.
  }, [projectName])

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
          router.replace(`/project/${encodeURIComponent(projectName)}/terminal`)
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
      router.replace(`/project/${encodeURIComponent(projectName)}/terminal`)
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
          const dbMatches = await countSessionJobs(projectName, initialSessionId)
          if (dbMatches <= userEntries) return
        } catch {
          return
        }
      }

      if (cancelled) return
      await fetchSessionJobs(projectName, initialSessionId)
      .then(async (jobs) => {
        const matches = jobs
          .filter(j => isRestorableSessionKind(j.kind))
          .sort((a, b) => a.started_at - b.started_at)
        if (matches.length === 0) return

        const firstMatch = matches[0]
        const { skills: loadedSkills, docs: loadedDocs } = contextItemsFromMeta(firstMatch.context_meta)

        const lastMatch = matches[matches.length - 1]
        const lastIsRunning = lastMatch.status !== 'done' && lastMatch.finished_at === null
        const completedMatches = lastIsRunning ? matches.slice(0, -1) : matches

        const entries = await buildEntriesForCompletedJobs(completedMatches)

        const sessionProvider = matches.find(m => m.provider)?.provider ?? null
        if (lastIsRunning) {
          if (attachedSessionJobRef.current === lastMatch.id) return
          const retrievedContextEntry = retrievedContextEntryFromMeta(lastMatch.context_meta)
          if (retrievedContextEntry) entries.push(retrievedContextEntry)
          const prompt = restoredPrompt(lastMatch)
          if (prompt) entries.push({ role: 'user', text: prompt })
          attachedSessionJobRef.current = lastMatch.id
          terminalStore.update(projectName, () => ({
            history: entries,
            claudeSessionId: initialSessionId,
            sessionKey: initialSessionId,
            sessionProvider,
            selectedItems: loadedSkills,
            selectedDocs: loadedDocs,
            restoredFor: initialSessionId,
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
        if (shouldRedirectJobParamToSession(data)) {
          router.replace(`/project/${encodeURIComponent(projectName)}/terminal/${encodeURIComponent(data.session_id)}`)
          return
        }
        setCurrentReleaseId(data.release_id ?? null)
        const entries: TermEntry[] = []
        const kind = data.kind || jobParam.split('-').slice(1, -1).join('-')
        // System agents are billed under `agent:*` job kinds for scheduling
        // parity but never spawn a CLI — they finish in-process and stash
        // their output in `work_summary` / contextMeta. Treat them as
        // non-streaming so we render the summary instead of trying to tail
        // a stream-json log that was never produced.
        // One parse — both the system-agent check and the skills/docs
        // extraction below read from the same string.
        let metaParsed: { system?: unknown; skills?: unknown; docs?: unknown } | null = null
        if (data.context_meta) {
          try { metaParsed = JSON.parse(data.context_meta) } catch { /* ignore */ }
        }
        const isSystemAgent = !!(metaParsed && metaParsed.system === true)
        const isClaudeJob = isClaudeJobKind(data.kind) && !isSystemAgent
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
        const retrievedContextEntry = retrievedContextEntryFromMeta(data.context_meta)
        if (retrievedContextEntry) entries.push(retrievedContextEntry)

        if (jobPrompt) {
          entries.push({ role: 'user', text: jobPrompt })
        }

        if (metaParsed) {
          const skills = metaParsed.skills
          if (Array.isArray(skills)) {
            terminalStore.update(projectName, () => ({ selectedItems: skills }))
          }
          const docs = metaParsed.docs
          if (Array.isArray(docs)) {
            terminalStore.update(projectName, () => ({ selectedDocs: docs }))
          }
        }

        terminalStore.reset(projectName)

        if (isSystemAgent) {
          // System agents run in-process and never produce a stream-json
          // transcript. Their meaningful output lives in `work_summary`
          // (e.g. "reindex: 12 indexed, 0 skipped, 234 chunks · verify: …").
          // Surface it as a status entry so the terminal page doesn't show
          // an empty exit alongside the bare prompt placeholder.
          if (data.work_summary) {
            entries.push({ role: 'status', text: data.work_summary })
          }
          const exitCode = data.exit_code
          if (exitCode !== undefined && exitCode !== null) {
            entries.push(terminalExitEntry(exitCode))
          }
          terminalStore.update(projectName, () => ({ history: entries }))
        } else if (isClaudeJob) {
          terminalStore.update(projectName, () => ({ history: entries }))
          terminalStore.startStream(
            projectName,
            jobParam,
            false,
            hasPrerequisiteContext(data.context_meta),
          )
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

  // Session routes should also notice when a later turn in the same session
  // starts after the page is already open, then attach to that live job.
  useEffect(() => {
    if (!initialSessionId || jobParam) return
    let cancelled = false
    let inFlight = false

    const poll = async () => {
      if (inFlight) return
      // Don't poll while the tab is hidden — this effect otherwise re-fetches
      // the session's job list + every job's detail on a fixed interval even
      // for a fully-finished session (it never attaches, so it never
      // self-suspends). Resumes via the visibilitychange listener below.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const cur = terminalStore.get(projectName)
      if (cur.streaming || cur.currentJobId) return

      inFlight = true
      try {
        const jobs = await fetchSessionJobs(projectName, initialSessionId)
        if (cancelled) return

        const latest = terminalStore.get(projectName)
        if (latest.streaming || latest.currentJobId) return

        const matches = jobs
          .filter((job) => isRestorableSessionKind(job.kind))
          .sort((a, b) => a.started_at - b.started_at)
        if (matches.length === 0) return

        const lastMatch = matches[matches.length - 1]
        const lastIsRunning = lastMatch.status !== 'done' && lastMatch.finished_at === null
        if (!lastIsRunning) return
        if (attachedSessionJobRef.current === lastMatch.id) return

        let entries = latest.restoredFor === initialSessionId && latest.history.length > 0
          ? [...latest.history]
          : await buildEntriesForCompletedJobs(matches.slice(0, -1))
        if (cancelled) return

        const beforeAttach = terminalStore.get(projectName)
        if (beforeAttach.streaming || beforeAttach.currentJobId) return
        if (attachedSessionJobRef.current === lastMatch.id) return
        if (beforeAttach.restoredFor === initialSessionId && beforeAttach.history.length > 0) {
          entries = [...beforeAttach.history]
        }

        const { skills: loadedSkills, docs: loadedDocs } = contextItemsFromMeta(matches[0].context_meta)
        const retrievedContextEntry = retrievedContextEntryFromMeta(lastMatch.context_meta)
        if (retrievedContextEntry) entries.push(retrievedContextEntry)
        const prompt = restoredPrompt(lastMatch)
        if (prompt) entries.push({ role: 'user', text: prompt })

        const sessionProvider = matches.find((match) => match.provider)?.provider ?? null
        attachedSessionJobRef.current = lastMatch.id
        terminalStore.update(projectName, () => ({
          history: entries,
          claudeSessionId: initialSessionId,
          sessionKey: initialSessionId,
          sessionProvider,
          selectedItems: loadedSkills,
          selectedDocs: loadedDocs,
          restoredFor: initialSessionId,
        }))
        terminalStore.startStream(
          projectName,
          lastMatch.id,
          false,
          hasPrerequisiteContext(lastMatch.context_meta),
        )
      } catch {
      } finally {
        inFlight = false
      }
    }

    void poll()
    // 2s (was 250ms): this only needs to *notice* a new turn in the session,
    // not tail it in real time — the SSE stream does the live rendering once
    // attached. 250ms meant ~4 job-list + per-job-detail refetches/sec for the
    // whole time a finished session was open. Poll once immediately on refocus
    // so returning to the tab catches a new turn without waiting a full tick.
    const id = setInterval(() => {
      if (!cancelled) void poll()
    }, 2000)
    const onVisible = () => { if (!cancelled && document.visibilityState === 'visible') void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [initialSessionId, jobParam, projectName])

  // Fresh terminal landing pages should attach to newly-started release jobs
  // and ordinary runs so the operator sees live work without manually
  // refreshing. Agent jobs still stay out of the interactive terminal.
  useEffect(() => {
    if (initialSessionId || jobParam) return
    let cancelled = false

    const poll = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const cur = terminalStore.get(projectName)
      if (
        cur.streaming ||
        cur.currentJobId ||
        cur.history.length > 0 ||
        cur.pendingAutoSubmit
      ) return
      try {
        const res = await fetch(`/api/jobs?project=${encodeURIComponent(projectName)}&status=running&limit=10`)
        if (!res.ok) return
        const data = await res.json()
        const runningJobs: JobDict[] = (data.jobs ?? [])
          .filter((job: JobDict) => job.status === 'running' && (job.kind === 'release' || job.kind === 'run'))
          .sort((a: JobDict, b: JobDict) => b.started_at - a.started_at)
        const target = runningJobs[0]
        if (!target || attachedExternalJobRef.current === target.id) return
        const href = landingAutoAttachHref(projectName, target)
        if (!href) return
        attachedExternalJobRef.current = target.id
        router.replace(href)
      } catch {}
    }

    const id = setInterval(() => {
      if (!cancelled) void poll()
    }, 1000)
    const onVisible = () => { if (!cancelled && document.visibilityState === 'visible') void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [initialSessionId, jobParam, projectName, router])

  return { currentReleaseId }
}
