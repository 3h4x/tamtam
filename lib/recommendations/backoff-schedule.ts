import type { Recommendation } from '@/lib/client-api'
import { nextSlowerSchedule, scheduleHours, DEFAULT_BACKOFF_SCHEDULE } from '@/lib/scheduling/schedule-ladder'

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

  return nextSlowerSchedule(item.payload?.currentSchedule)
}
