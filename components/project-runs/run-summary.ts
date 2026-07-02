import { entryNeedsAttention } from '@/components/project-runs/entries'
import type { Entry } from '@/components/project-runs/types'

// Normalization for the human-authored "TamTam run report" block that agents
// and pipeline steps append to their output. Extracted from RunRow so the
// (regex-heavy) logic can be unit-tested and reused by the detail drawer.

const SUMMARY_SECTION_LABELS = [
  'Summary:',
  'Files changed:',
  'Actionable work:',
  'Fixes applied:',
  'Findings NOT fixed:',
  'Verification completed:',
  'UX verdict per flow:',
]

const SUMMARY_SECTION_PATTERN = SUMMARY_SECTION_LABELS
  .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

const STRUCTURED_SUMMARY_RE = new RegExp(
  `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:\\*\\*)?(?:${SUMMARY_SECTION_PATTERN})(?:\\*\\*)?\\s*`,
  'i',
)

const INLINE_SECTION_RE = new RegExp(`\\s+(?=(?:${SUMMARY_SECTION_PATTERN}))`, 'g')

// Compile per-label "label \s*" regexes ONCE at module load. Without this,
// `formatRunSummaryText` allocated len(SUMMARY_SECTION_LABELS) regex objects on
// every call, plus one more for the leading-bullet strip — and the function is
// invoked once per visible run row's summary.
const LEADING_BULLET_BEFORE_SECTION_RE = new RegExp(
  `^\\s*[-*]\\s+(?=(?:${SUMMARY_SECTION_PATTERN}))`,
  'gm',
)
const SECTION_BREAK_RES: ReadonlyArray<{ label: string; re: RegExp }> = SUMMARY_SECTION_LABELS.map((label) => ({
  label,
  re: new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'),
}))

/** Normalize a run/step work-summary into clean, section-broken text (or null). */
export function formatRunSummaryText(value: string | null | undefined): string | null {
  if (!value) return null

  const trimmed = value.trim()
  if (!trimmed) return null
  if (!STRUCTURED_SUMMARY_RE.test(trimmed)) return trimmed

  let text = value
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*---+\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(LEADING_BULLET_BEFORE_SECTION_RE, '')

  text = text.replace(INLINE_SECTION_RE, '\n')

  for (const { label, re } of SECTION_BREAK_RES) {
    text = text.replace(re, `${label}\n`)
  }

  text = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')

  return text || null
}

/** Split a "test ✓ · review LGTM · …" recap into its individual step parts. */
export function splitSummary(summary: string | null | undefined): string[] {
  if (!summary) return []
  return summary
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean)
}

/** The last recap part that reads as a failure/attention/pending step, if any. */
export function lastFailedSummaryPart(parts: string[]): string | null {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]
    const lower = part.toLowerCase()
    if (part.includes('✗') || lower.includes('fail') || lower.includes('attention') || lower.includes('blocked') || lower.includes('pending')) {
      return part
    }
  }
  return null
}

/**
 * Walk an entry's nested children/chain and return the most recent failing
 * child's summary/subtitle/detail — used to explain a parent (release/agent)
 * that failed because one of its steps did.
 */
export function latestFailureSummary(entry: Entry): string | null {
  const children: Entry[] = []
  const seen = new Set<string>()
  const collect = (nodes: Entry[]) => {
    for (const node of nodes) {
      if (seen.has(node.key)) continue
      seen.add(node.key)
      children.push(node)
      collect(node.children ?? [])
      collect(node.chainedChildren ?? [])
    }
  }
  collect([...(entry.children ?? []), ...(entry.chainedChildren ?? [])])
  const failedChildren = children
    .filter((child) => entryNeedsAttention(child))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const latestFailure = failedChildren.find((child) => child.workSummary || child.subtitle || child.detail)
    ?? failedChildren[0]
  return latestFailure?.workSummary ?? latestFailure?.subtitle ?? latestFailure?.detail ?? null
}
