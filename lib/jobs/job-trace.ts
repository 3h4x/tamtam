import { listJobs, getVerdict, readLog } from '@/lib/jobs/job-storage'
import type { JobData } from '@/lib/jobs/job-storage'
import type {
  JobTrace,
  JobTraceStep,
  JobTraceTrigger,
  JobRunStatus,
} from '@/lib/jobs/job-trace-types'

// Steps to include in a release's timeline. `mark-dod-verify` is display-only
// here — it never gates the release (see components/project-runs/work-units.ts)
// but the drawer shows it so the DoD verification is visible alongside the
// gating phases.
const RELEASE_STEP_KINDS = new Set([
  'test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod', 'soak', 'mark-dod-verify',
])

export function jobRunStatus(job: Pick<JobData, 'abortedAt' | 'finishedAt'>): JobRunStatus {
  if (job.abortedAt != null) return 'aborted'
  if (job.finishedAt != null) return 'done'
  return 'running'
}

function stepLogExcerpt(job: JobData, take = 500): string {
  const raw = readLog(job, 3000)
  return raw
    .replace(/\{"type":"[^"]+","subtype[^}]+\}/g, '')
    .trim()
    .slice(-take)
}

/**
 * Pipeline step jobs sharing a release, oldest first, with verdict + a trimmed
 * log excerpt. Shared by the release-trace route and buildJobTrace so there is
 * a single log/excerpt implementation.
 */
export function buildPipelineSteps(all: JobData[], project: string, releaseId: string): JobTraceStep[] {
  return all
    .filter((j) => j.project === project && j.releaseId === releaseId && RELEASE_STEP_KINDS.has(j.kind))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((j) => ({
      job_id: j.id,
      kind: j.kind,
      status: jobRunStatus(j),
      exit_code: j.exitCode ?? null,
      started_at: j.startedAt,
      finished_at: j.finishedAt ?? null,
      duration_ms: j.durationMs ?? null,
      verdict: getVerdict(j) ?? null,
      log_excerpt: stepLogExcerpt(j),
    }))
}

function triggerLabel(kind: string): string {
  if (kind.startsWith('agent:')) return `agent ${kind.replace(/^agent:/, '')}`
  if (kind === 'run') return 'terminal run'
  return kind
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseContextMeta(raw: string | null | undefined): {
  releaseStopReason: string | null
  outcomeVerdict: string | null
  followupIssueUrl: string | null
  followupIssueNumber: number | null
} {
  const empty = { releaseStopReason: null, outcomeVerdict: null, followupIssueUrl: null, followupIssueNumber: null }
  if (!raw) return empty
  try {
    const m = JSON.parse(raw)
    return {
      releaseStopReason: typeof m?.releaseStopReason === 'string' ? m.releaseStopReason : null,
      outcomeVerdict: typeof m?.outcomeClassification?.verdict === 'string' ? m.outcomeClassification.verdict : null,
      followupIssueUrl: typeof m?.followupIssueUrl === 'string' ? m.followupIssueUrl : null,
      followupIssueNumber: typeof m?.followupIssueNumber === 'number' ? m.followupIssueNumber : null,
    }
  } catch {
    return empty
  }
}

/**
 * Assemble the complete trace for any job id — the unit itself, the job that
 * triggered it, the release pipeline it is or owns (with per-step verdicts and
 * log excerpts), plus the work report, files, usage, and context. Returns null
 * when the job id is unknown.
 */
export function buildJobTrace(jobId: string): JobTrace | null {
  const all = listJobs()
  const unit = all.find((j) => j.id === jobId)
  if (!unit) return null

  // Resolve the associated release: the unit itself if it is a release; else
  // the (latest) release it triggered; else the release it belongs to.
  let release: JobData | null = null
  if (unit.kind === 'release') {
    release = unit
  } else {
    release = all
      .filter((j) => j.kind === 'release' && j.parentJobId === unit.id)
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
    if (!release && unit.releaseId) {
      release = all.find((j) => j.id === unit.releaseId && j.kind === 'release') ?? null
    }
  }

  const steps = release ? buildPipelineSteps(all, release.project, release.id) : []

  let trigger: JobTraceTrigger | null = null
  if (unit.parentJobId) {
    const p = all.find((j) => j.id === unit.parentJobId)
    if (p) {
      trigger = {
        job_id: p.id,
        kind: p.kind,
        label: triggerLabel(p.kind),
        prompt: p.userPrompt ?? p.prompt ?? null,
      }
    }
  }

  const ctx = parseContextMeta(unit.contextMeta)
  // A release meta-job's own log is aggregate noise; only show a unit log
  // excerpt for non-release units (chats, agents, standalone steps).
  const logExcerpt = unit.kind === 'release' ? null : stepLogExcerpt(unit, 800)
  const rawPrompt = unit.userPrompt ?? unit.prompt ?? null

  return {
    job_id: unit.id,
    project: unit.project,
    kind: unit.kind,
    prompt: rawPrompt ? truncate(rawPrompt, 400) : null,
    status: jobRunStatus(unit),
    exit_code: unit.exitCode ?? null,
    started_at: unit.startedAt,
    finished_at: unit.finishedAt ?? null,
    duration_ms: unit.durationMs ?? null,
    verdict: getVerdict(unit) ?? null,
    session_id: unit.sessionId ?? null,
    release_id: release?.id ?? null,
    trigger,
    steps,
    workSummary: unit.workSummary ?? null,
    files: {
      files: parseStringArray(unit.modifiedFiles),
      linesAdded: unit.linesAdded ?? null,
      linesRemoved: unit.linesRemoved ?? null,
    },
    usage: {
      inputTokens: unit.inputTokens ?? 0,
      outputTokens: unit.outputTokens ?? 0,
      cacheReadTokens: unit.cacheReadTokens ?? 0,
      cacheCreateTokens: unit.cacheCreateTokens ?? 0,
      costUsd: unit.costUsd ?? 0,
      promptBytes: unit.promptBytes ?? null,
      model: unit.model ?? null,
      provider: unit.provider ?? null,
    },
    context: {
      skills: parseStringArray(unit.skillIds),
      releaseStopReason: ctx.releaseStopReason,
      outcomeVerdict: ctx.outcomeVerdict,
      followupIssueUrl: ctx.followupIssueUrl,
      followupIssueNumber: ctx.followupIssueNumber,
      runScore: unit.runScore ?? null,
    },
    logExcerpt,
    logPruned: !!unit.logPruned,
  }
}
