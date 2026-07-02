import type { PillTone } from '@/components/ui/Pill'
import type { ReleaseOutcome } from '@/components/project-runs/types'

// Pure label/tone derivation for the history row badges. Extracted from RunRow
// so the mapping is unit-tested in one place instead of inferred inline by
// substring sniffing at several call sites.

export interface BadgeInfo {
  label: string
  tone: PillTone
}

/** Review verdict → badge. Null when there is no verdict to convey. */
export function verdictBadgeInfo(verdict: string | null | undefined): BadgeInfo | null {
  if (!verdict) return null
  if (verdict === 'LGTM') return { label: '✓ LGTM', tone: 'success' }
  if (verdict === 'DO NOT SHIP') return { label: '✗ DNS', tone: 'error' }
  return { label: '⚠ ATTN', tone: 'warning' }
}

/** Local-LLM outcome verdict (agent/run rows) → badge. */
export function gemmaOutcomeInfo(verdict: string | null | undefined): BadgeInfo | null {
  if (verdict === 'done') return { label: '✓ done', tone: 'success' }
  if (verdict === 'asked_question') return { label: '? asked', tone: 'info' }
  if (verdict === 'needs_continue') return { label: '↻ unfinished', tone: 'warning' }
  return null
}

export interface RowStateInfo extends BadgeInfo {
  running: boolean
}

/**
 * The primary state chip (running / done / failure). `-1` is TamTam's sentinel
 * for "never exited normally" (spawn error or signal kill), so render the
 * condition rather than a literal "exit -1".
 */
export function rowStateInfo({
  isRunning,
  isFailed,
  exitCode,
  failureLabel,
}: {
  isRunning: boolean
  isFailed: boolean
  exitCode: number | null | undefined
  failureLabel?: string | null
}): RowStateInfo {
  if (isRunning) return { label: 'running', tone: 'info', running: true }
  if (!isFailed) return { label: 'done', tone: 'success', running: false }
  const label = failureLabel ?? (exitCode === -1 ? 'failed to start' : `exit ${exitCode}`)
  return { label, tone: 'error', running: false }
}

/** Release-outcome chip for an agent/run row that owns a release. */
export function releaseOutcomeInfo(outcome: ReleaseOutcome | null | undefined): BadgeInfo | null {
  if (!outcome) return null
  const tone: PillTone =
    outcome.status === 'running' ? 'info' :
    outcome.status === 'done' ? 'success' :
    outcome.status === 'blocked' ? 'warning' :
    'error'
  return { label: outcome.status === 'done' ? '✓ release done' : outcome.label, tone }
}

/** Tone for a single recap step chip ("commit ✓", "review LGTM", "test ✗1"). */
export function stepChipTone(value: string): PillTone {
  const lower = value.toLowerCase()
  const failed = value.includes('✗') || lower.includes('fail') || lower.includes('attention') || lower.includes('ship') || lower.includes('blocked')
  const pending = lower.includes('pending') || lower.includes('queued') || lower.includes('running')
  const done = lower.includes('✓') || lower.includes('lgtm') || lower.includes('done') || lower.includes('completed')
  if (failed) return 'error'
  if (pending) return 'info'
  if (done) return 'success'
  return 'neutral'
}

/** Border/bg/text classes for the live "now: review" progress chip. */
export function progressToneClass(label: string | null | undefined): string {
  if (!label) return 'border-accent/25 bg-accent/10 text-accent'
  if (label.includes('now:')) return 'border-status-info/30 bg-status-info/10 text-status-info'
  if (label.includes('failed') || label.includes('stopped') || label.includes('cancelled') || label.includes('blocked')) {
    return 'border-status-error/30 bg-status-error/10 text-status-error'
  }
  return 'border-accent/25 bg-accent/10 text-accent'
}

// Prompt-bloat indicator. Every cache-read of an oversized prefix is billed, so
// a fat prompt is real recurring cost. Show from 20 KB, alert at 50 KB.
export const PROMPT_BYTES_WARN = 20_000
export const PROMPT_BYTES_ALERT = 50_000

export interface PromptBloatInfo {
  show: boolean
  alert: boolean
  label: string
  bytes: number
}

export function promptBloat(bytes: number | null | undefined): PromptBloatInfo {
  const b = bytes ?? 0
  return {
    show: b >= PROMPT_BYTES_WARN,
    alert: b >= PROMPT_BYTES_ALERT,
    label: b >= 1024 ? `${Math.round(b / 1024)}KB` : `${b}B`,
    bytes: b,
  }
}

/** Count entries in a modified-files JSON array (0 on any parse failure). */
export function modifiedFileCount(raw: string | null | undefined): number {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/** Parse a modified-files JSON array into a string list (empty on failure). */
export function parseModifiedFiles(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
