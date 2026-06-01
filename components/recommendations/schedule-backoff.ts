import type { Recommendation } from '@/lib/client-api'

// Cadence ladder, ascending by duration. "Decrease rate" steps an unfruitful
// agent to the next-slower rung so a noisy agent can be throttled in one click
// without the operator hand-computing an interval.
const BACKOFF_LADDER = ['15m', '1h', '4h', '8h', '24h', '7d'] as const

// When the current cadence is unknown/unparseable we can't place it on the
// ladder, but the operator still wants a one-click throttle — default to a
// conservative 8h so the action stays available.
const DEFAULT_BACKOFF_SCHEDULE = '8h'

function scheduleHours(schedule: unknown): number | null {
  if (typeof schedule !== 'string') return null
  const match = schedule.trim().match(/^(\d+)([mhd])$/i)
  if (!match) return null
  const [, rawValue, unit] = match
  if (!rawValue || !unit) return null
  const value = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(value) || value <= 0) return null
  switch (unit.toLowerCase()) {
    case 'm':
      return value / 60
    case 'd':
      return value * 24
    default:
      return value
  }
}

function isUserEditableAgentId(agentId: string | null): boolean {
  return agentId !== null && !agentId.startsWith('system:')
}

// Returns the next-slower ladder cadence for an unfruitful agent, or null when
// there's nothing slower to step to (already at/over the slowest rung) or the
// recommendation isn't a user-editable unfruitful agent.
// Types where "run less often" is a valid remedy: an unfruitful agent that
// keeps producing nothing, or a health/noise concern advising fewer runs.
const BACKOFF_ELIGIBLE_TYPES = new Set(['agent_unfruitful', 'orchestrator_agent_health'])

export function recommendationBackoffSchedule(item: Recommendation): string | null {
  if (!BACKOFF_ELIGIBLE_TYPES.has(item.type)) return null
  if (!isUserEditableAgentId(item.agent_id)) return null

  const currentHours = scheduleHours(item.payload?.currentSchedule)
  if (currentHours == null) return DEFAULT_BACKOFF_SCHEDULE

  for (const step of BACKOFF_LADDER) {
    const stepHours = scheduleHours(step)
    if (stepHours != null && stepHours > currentHours) return step
  }
  return null
}
