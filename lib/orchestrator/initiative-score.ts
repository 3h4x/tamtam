import type { InitiativeRow } from '@/lib/orchestrator/initiatives-store';

// Higher = more urgent. Gaps left between tiers so PM features (Phase 2) can
// slot in without renumbering. lint/type-error share the top tier (broken build).
export const CHORE_SEVERITY: Record<string, number> = {
  'type-error': 100,
  'lint': 100,
  'failing-test': 80,
  'gh-issue': 70,
  'missing-test': 60,
  'todo': 40,
  // A backend route shipped with no UI/client surface — a real product gap, but
  // advisory (may be an intentionally-internal endpoint), so below test debt.
  'ui-coverage': 25,
  'dep-bump': 20,
  'docs-gap': 10,
};

export function choreBaseScore(kind: string): number {
  return CHORE_SEVERITY[kind] ?? 0;
}

export function decayedScore(row: Pick<InitiativeRow, 'score' | 'attempts'>): number {
  return row.score * Math.pow(0.5, row.attempts);
}
