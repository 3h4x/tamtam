// Pure adapters from the two source feeds into the shared AttentionItem shape,
// plus the merge/sort that interleaves them. Runtime imports are the pure
// recommendation classifier + action derivation only — safe to call from the
// server route and unit-test without a DB or network.

import type { InboxSignal } from '@/lib/workflows/inbox';
import type { RecommendationRow } from '@/lib/recommendations/recommendations';
import { isManualRecommendation } from '@/lib/recommendations/classification';
import { recommendationActions } from '@/lib/attention/recommendation-actions';
import type { AttentionItem, AttentionCounts, AttentionSeverity } from '@/lib/attention/types';

// red → yellow → green, matching the inbox's own ordering.
const SEVERITY_RANK: Record<AttentionSeverity, number> = { red: 0, yellow: 1, green: 2 };

export function inboxSignalToItem(s: InboxSignal): AttentionItem {
  return {
    id: `signal:${s.id}`,
    source: 'signal',
    project: s.project,
    severity: s.severity,
    title: s.title,
    detail: s.detail,
    ageSeconds: s.ageSeconds,
    href: s.href,
    externalUrl: s.externalUrl,
    actions: [{ kind: s.action.kind, label: s.action.label, prNumber: s.action.prNumber }],
    agent: null,
    dismissible: false,
  };
}

// A recommendation is never red: MANUAL (operator must act) → yellow, AUTO
// (orchestrator already handled it, FYI) → green. Red stays reserved for
// shippability blockers from the inbox side. `app_health` is operator-actionable
// (a DEGRADED/DOWN app needs a human) but is classified outside the MANUAL agent-
// quality set, so it is pinned yellow here rather than defaulting to green/AUTO.
export function recommendationToItem(rec: RecommendationRow): AttentionItem {
  return {
    id: `rec:${rec.id}`,
    source: 'recommendation',
    project: rec.project,
    severity: rec.type === 'app_health' || isManualRecommendation(rec.type) ? 'yellow' : 'green',
    title: rec.title,
    detail: rec.detail,
    ageSeconds: rec.updated_at ? Math.max(0, Math.floor(Date.now() / 1000 - rec.updated_at)) : null,
    href: `/project/${encodeURIComponent(rec.project)}`,
    externalUrl: null,
    actions: recommendationActions(rec),
    agent: rec.agent_id ? { id: rec.agent_id, name: rec.agent_name } : null,
    dismissible: true,
  };
}

export function countAttention(items: AttentionItem[]): AttentionCounts {
  const counts: AttentionCounts = { red: 0, yellow: 0, green: 0, total: items.length };
  for (const i of items) counts[i.severity] += 1;
  return counts;
}

// Interleave inbox signals with already-mapped recommendation items and sort:
// severity first (red blockers on top), then oldest-first within a severity,
// then project name for a stable order. Returns the sorted list + its counts.
export function mergeAttention(
  signals: InboxSignal[],
  recItems: AttentionItem[],
): { items: AttentionItem[]; counts: AttentionCounts } {
  const items = [...signals.map(inboxSignalToItem), ...recItems];
  items.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const ageA = a.ageSeconds ?? -1;
    const ageB = b.ageSeconds ?? -1;
    return ageB - ageA || a.project.localeCompare(b.project);
  });
  return { items, counts: countAttention(items) };
}
