import { describe, expect, it } from 'vitest'
import type { Recommendation } from '@/lib/client-api'
import { recommendationBackoffSchedule } from '@/lib/recommendations/backoff-schedule'

function makeRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'rec-1',
    project: 'alpha',
    source_kind: 'agent:improve',
    source_id: 'job-1',
    agent_id: 'agent-1',
    agent_name: 'improve',
    type: 'agent_unfruitful',
    title: "improve isn't producing changes",
    detail: 'No changes.',
    status: 'open',
    payload: { currentSchedule: '15m' },
    created_at: 100,
    updated_at: 200,
    ...overrides,
  }
}

describe('recommendationBackoffSchedule', () => {
  it('steps to the next-slower cadence on the ladder', () => {
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: '15m' } }))).toBe('1h')
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: '1h' } }))).toBe('4h')
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: '4h' } }))).toBe('8h')
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: '8h' } }))).toBe('24h')
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: '24h' } }))).toBe('7d')
  })

  it('steps to the next ladder rung strictly slower than an off-ladder cadence', () => {
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: '12h' } }))).toBe('24h')
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: '30m' } }))).toBe('1h')
  })

  it('returns null only when already at or slower than the slowest rung', () => {
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: '7d' } }))).toBeNull()
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: '14d' } }))).toBeNull()
  })

  it('defaults to 8h when the current schedule is missing or unparseable (still throttleable)', () => {
    expect(recommendationBackoffSchedule(makeRec({ payload: {} }))).toBe('8h')
    expect(recommendationBackoffSchedule(makeRec({ payload: { currentSchedule: 'nightly' } }))).toBe('8h')
    expect(recommendationBackoffSchedule(makeRec({ payload: null }))).toBe('8h')
  })

  it('is eligible for unfruitful and health (noise → run less), but not other types', () => {
    // Health/noise concerns advise fewer runs, so backoff applies there too.
    expect(recommendationBackoffSchedule(makeRec({ type: 'orchestrator_agent_health', payload: { currentSchedule: '15m' } }))).toBe('1h')
    expect(recommendationBackoffSchedule(makeRec({ type: 'agent_schedule_backoff' }))).toBeNull()
    expect(recommendationBackoffSchedule(makeRec({ type: 'orchestrator_boost' }))).toBeNull()
  })

  it('returns null for system agents (not user-editable)', () => {
    expect(recommendationBackoffSchedule(makeRec({ agent_id: 'system:retrieval-reindex' }))).toBeNull()
  })

  it('returns null when there is no agent target', () => {
    expect(recommendationBackoffSchedule(makeRec({ agent_id: null }))).toBeNull()
  })
})
