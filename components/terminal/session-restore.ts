import {
  buildTerminalEntriesFromJobLog,
  terminalExitEntry,
  type DocItem,
  type SkillItem,
  type TermEntry,
} from '@/lib/terminal/terminal-session-store'
import { hasPrerequisiteContext } from './prerequisite-context'

export interface RestorableJob {
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

interface JobLogDetail {
  log?: string | null
  log_pruned?: boolean
  exit_code?: number | null
}

export function isRestorableSessionKind(kind: string): boolean {
  return ['run', 'review', 'fix', 'fix-ci'].includes(kind) || kind.startsWith('agent:')
}

export function contextItemsFromMeta(contextMeta: string | null | undefined): {
  skills: SkillItem[]
  docs: DocItem[]
} {
  if (!contextMeta) return { skills: [], docs: [] }
  try {
    const meta = JSON.parse(contextMeta)
    return {
      skills: Array.isArray(meta?.skills) ? meta.skills : [],
      docs: Array.isArray(meta?.docs) ? meta.docs : [],
    }
  } catch {
    return { skills: [], docs: [] }
  }
}

async function fetchJobs(url: string): Promise<RestorableJob[]> {
  const res = await fetch(url)
  const data = await res.json()
  return Array.isArray(data.jobs) ? data.jobs : []
}

export async function fetchSessionJobs(projectName: string, sessionId: string): Promise<RestorableJob[]> {
  const project = encodeURIComponent(projectName)
  const session = encodeURIComponent(sessionId)
  try {
    const jobs = await fetchJobs(`/api/jobs?project=${project}&session_id=${session}&limit=200`)
    if (jobs.length > 0) return jobs
  } catch {}

  const jobs = await fetchJobs(`/api/jobs?project=${project}`)
  return jobs.filter((job) => job.session_id === sessionId)
}

export async function countSessionJobs(projectName: string, sessionId: string): Promise<number> {
  return (await fetchSessionJobs(projectName, sessionId))
    .filter((job) => isRestorableSessionKind(job.kind)).length
}

export async function buildEntriesForCompletedJobs(jobs: RestorableJob[]): Promise<TermEntry[]> {
  const logData = await Promise.all(
    jobs.map((job) =>
      fetch(`/api/jobs/${encodeURIComponent(job.id)}`)
        .then((res) => res.json() as Promise<JobLogDetail>)
        .catch(() => null),
    ),
  )
  const entries: TermEntry[] = []
  jobs.forEach((job, index) => {
    const prompt = job.user_prompt || job.prompt
    if (prompt) entries.push({ role: 'user', text: prompt })

    const detail = logData[index]
    const exitCode = typeof detail?.exit_code === 'number' ? detail.exit_code : job.exit_code
    const exitEntry = exitCode !== null && exitCode !== undefined
      ? terminalExitEntry(exitCode)
      : null

    if (detail?.log) {
      if (exitEntry?.text === 'cancelled') {
        entries.push(...buildTerminalEntriesFromJobLog(detail.log, {
          passthrough: hasPrerequisiteContext(job.context_meta),
        }))
        entries.push(exitEntry)
      } else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
        entries.push({ role: 'error', text: 'claude run failed' })
        entries.push(...buildTerminalEntriesFromJobLog(detail.log, {
          passthrough: hasPrerequisiteContext(job.context_meta),
          fallbackRole: 'error',
        }))
      } else {
        entries.push(...buildTerminalEntriesFromJobLog(detail.log, {
          passthrough: hasPrerequisiteContext(job.context_meta),
        }))
      }
    } else if (detail?.log_pruned) {
      entries.push({ role: 'status', text: 'Log file deleted by retention policy' })
      if (exitEntry) entries.push(exitEntry)
    } else if (exitEntry && exitCode !== 0) {
      entries.push(exitEntry)
    }
  })
  return entries
}
