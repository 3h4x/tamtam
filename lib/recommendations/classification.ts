// Recommendation type classification — pure sets + predicates, no runtime deps.
// Lives here (not in the client module) so BOTH the client UI and server code
// (the unified-inbox adapter, `lib/attention/`) can classify a recommendation
// without pulling in client fetch-cache. Re-exported from `lib/client/projects.ts`
// for backward-compat with existing `@/lib/client-api` importers.

// Auto-apply whitelist — only types whose payload is unambiguous and whose
// effect is reversible should be auto-applicable. Anything else stays
// dismiss-only until the recommendation type is explicitly designed.
export const AUTO_APPLICABLE_RECOMMENDATION_TYPES = new Set([
  'agent_schedule_backoff',
])

// AUTO vs MANUAL describes WHO can resolve the recommendation, not who detected
// it. An "AUTO" recommendation is one the orchestrator resolves end-to-end on
// its own — it already took the action and there is nothing for the operator to
// do, so it carries the green AUTO pill and offers no Fix actions (dismiss only).
//   - orchestrator_boost : the orchestrator already fired the extra run; done.
//   - agent_autopilot    : the orchestrator already throttled cadence / down-
//                          graded the model (or restored either); done.
//
// Everything else is "manual": the orchestrator can DETECT it (and will
// auto-close the card if the situation later recovers — see
// `resolveRecommendationIfOpen`), but it cannot drive the fix itself. The
// operator must act, so these carry the amber MANUAL pill plus a Fix menu:
//   - agent_unfruitful          : widen the prompt / throttle / disable
//   - orchestrator_agent_health : narrow scope / investigate / throttle
//   - agent_schedule_backoff    : apply (or not) the slower cadence
export const AUTO_RECOMMENDATION_TYPES = new Set([
  'orchestrator_boost',
  'agent_autopilot',
])

// Types that flag operator-actionable work. They show the MANUAL pill and a Fix
// menu. Kept explicit (rather than "everything not AUTO") so a future
// informational type doesn't accidentally inherit a MANUAL pill.
export const MANUAL_RECOMMENDATION_TYPES = new Set([
  'agent_unfruitful',
  'orchestrator_agent_health',
  'agent_schedule_backoff',
])

export function isAutoRecommendation(type: string): boolean {
  return AUTO_RECOMMENDATION_TYPES.has(type)
}

export function isManualRecommendation(type: string): boolean {
  return MANUAL_RECOMMENDATION_TYPES.has(type)
}
