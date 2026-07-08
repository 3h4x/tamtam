// Agent roles — the classifier that decides how a scheduled agent's value is
// judged and which autopilot lever may reclaim its budget.
//
// Diff-count (files/lines changed) is a good value proxy for a *producer* but a
// terrible one for a *monitor* (a watchdog is most valuable when it finds
// nothing) or a *reviewer* (returns a verdict, not a diff) or a *planner*
// (files an issue, not code). So value + the safe cost-lever are functions of
// role. The five roles collapse to three autopilot policies:
//
//   producer            -> cadence-throttle when churning (never model-downgrade)
//   monitor/reviewer/planner -> model-downgrade when idle (NEVER cadence-throttle:
//                          that would kill freshness — the audit-logs problem)
//   publisher           -> untouched (deliberate published output; quality matters)
//
// See docs/ORCHESTRATOR.md and lib/orchestrator/agent-autopilot.ts.

export type AgentRole = 'producer' | 'monitor' | 'reviewer' | 'planner' | 'publisher';

export const ALL_AGENT_ROLES: readonly AgentRole[] = [
  'producer',
  'monitor',
  'reviewer',
  'planner',
  'publisher',
];

export const DEFAULT_AGENT_ROLE: AgentRole = 'producer';

/** Normalize an arbitrary stored/input value to a known role. Unknown or
 *  missing values fall back to 'producer' — the diff-judged, cadence-
 *  throttleable common case, which is also the safest default (it is the only
 *  role whose cadence autopilot will touch, and throttling is floor-bounded and
 *  reversible). */
export function parseAgentRole(value: unknown): AgentRole {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if ((ALL_AGENT_ROLES as readonly string[]).includes(v)) return v as AgentRole;
  }
  return DEFAULT_AGENT_ROLE;
}

/** Only producers are judged by diffs — so fruitfulness, the `agent_unfruitful`
 *  recommendation, and the `agent_schedule_backoff` recommendation apply to
 *  producers only. For every other role a no-diff run is normal/expected, not
 *  waste. */
export function valueIsDiffBased(role: AgentRole): boolean {
  return role === 'producer';
}

/** True only for agents whose runs are legitimately judged by code diffs — a
 *  non-system producer. Monitors / reviewers / planners (and any system agent)
 *  produce 0 diffs by design, so the diff-based cron dispatch gates (the CI-red
 *  deferral and the saturation backoff) must NOT silence them: a no-diff run is
 *  a successful pass, not saturation. Use this at those gate call sites so a
 *  monitor keeps its cadence instead of going quiet after a HEAD-stable streak. */
export function isSubjectToDiffGates(agent: { kind?: string | null; role: AgentRole }): boolean {
  return agent.kind !== 'system' && valueIsDiffBased(agent.role);
}

/** Producers are the only role the cadence autopilot may slow down. Monitors,
 *  reviewers and planners must keep their cadence (freshness); publishers are
 *  exempt entirely. */
export function isCadenceThrottleable(role: AgentRole): boolean {
  return role === 'producer';
}

/** Monitors, reviewers and planners can't be cadence-throttled without losing
 *  coverage, so their lever is a cheaper model tier while they're idle. */
export function isModelDowngradeable(role: AgentRole): boolean {
  return role === 'monitor' || role === 'reviewer' || role === 'planner';
}

/** Publishers are never auto-managed — extra firings over-publish and a cheaper
 *  model degrades user-visible output. */
export function isAutopilotExempt(role: AgentRole): boolean {
  return role === 'publisher';
}

// Keyword signals per role, checked against the agent's name + skills + prompt.
// Ordered so the more specific non-producer roles win before the producer
// default. Deterministic and token-free — far cheaper (and, for these
// well-known role words, more reliable) than an LLM classification on every
// agent create. Operators override the result explicitly in the editor.
const ROLE_KEYWORDS: Array<{ role: AgentRole; re: RegExp }> = [
  { role: 'publisher', re: /\b(blog|social|tweet|twitter|publish|newsletter|announce|marketing|post)\b/i },
  { role: 'monitor', re: /\b(audit|monitor|watch(dog)?|uptime|alert|health[- ]?check|scan(ning)? logs?|log scan|detect (errors?|anomal)|observ)\b/i },
  { role: 'reviewer', re: /\b(review|qa\b|quality assur|e2e|end[- ]to[- ]end|security (audit|review)|lint|verify|test(ing)?)\b/i },
  { role: 'planner', re: /\b(plan|research|recommend|roadmap|brainstorm|design (doc|spec)|triage|investigat)\b/i },
];

/** Heuristic role inference from an agent's name, skills, and prompt. Returns
 *  'producer' (the safe default) when nothing more specific matches. */
export function inferAgentRole(input: {
  name?: string | null;
  skillIds?: string[] | null;
  prompt?: string | null;
}): AgentRole {
  const haystack = [
    input.name ?? '',
    (input.skillIds ?? []).join(' '),
    input.prompt ?? '',
  ]
    .join(' ')
    .toLowerCase();
  for (const { role, re } of ROLE_KEYWORDS) {
    if (re.test(haystack)) return role;
  }
  return DEFAULT_AGENT_ROLE;
}
