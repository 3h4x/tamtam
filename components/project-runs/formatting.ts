import type { JobInfo } from '@/lib/client-api'
import { costUsd as computeCost } from '@/lib/shared/usage-pricing'

export function formatDuration(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt || Date.now() / 1000
  const s = Math.max(0, Math.floor(end - startedAt))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function dayKey(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function dayLabel(ts: number): string {
  const now = new Date()
  const d = new Date(ts * 1000)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export interface JobCountsResponse {
  total: number
  byKind: Record<string, number>
  byStatus: { running: number; done: number; aborted: number; failed: number }
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number; total: number }
  cost: { total: number; monthToDate: number }
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const numberProp = (value: unknown, key: string): number => {
  if (!value || typeof value !== 'object') return 0
  return finiteNumber((value as Record<string, unknown>)[key]) ?? 0
}

export function parseJobCountsResponse(value: unknown): JobCountsResponse | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const total = finiteNumber(raw.total)
  if (total == null) return null

  const rawByKind = raw.byKind && typeof raw.byKind === 'object'
    ? raw.byKind as Record<string, unknown>
    : {}
  const byKind: Record<string, number> = {}
  for (const [kind, count] of Object.entries(rawByKind)) {
    const n = finiteNumber(count)
    if (n != null) byKind[kind] = n
  }

  return {
    total,
    byKind,
    byStatus: {
      running: numberProp(raw.byStatus, 'running'),
      done: numberProp(raw.byStatus, 'done'),
      aborted: numberProp(raw.byStatus, 'aborted'),
      failed: numberProp(raw.byStatus, 'failed'),
    },
    tokens: {
      input: numberProp(raw.tokens, 'input'),
      output: numberProp(raw.tokens, 'output'),
      cacheRead: numberProp(raw.tokens, 'cacheRead'),
      cacheCreate: numberProp(raw.tokens, 'cacheCreate'),
      total: numberProp(raw.tokens, 'total'),
    },
    cost: {
      total: numberProp(raw.cost, 'total'),
      monthToDate: numberProp(raw.cost, 'monthToDate'),
    },
  }
}

export function jobCost(j: JobInfo): number {
  if (j.cost_usd != null) return j.cost_usd
  return computeCost({
    inputTokens: j.input_tokens ?? 0,
    outputTokens: j.output_tokens ?? 0,
    cacheReadTokens: j.cache_read_tokens ?? 0,
    cacheCreateTokens: j.cache_create_tokens ?? 0,
  })
}
