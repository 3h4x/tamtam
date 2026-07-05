// Shared shape for the unified Inbox feed. An AttentionItem is the common
// projection of BOTH an inbox signal (derived/stateless: repo shippability) and
// a recommendation (persisted/lifecycle: agent quality), so one row component
// and one merge/sort can render them together. The two source pipelines are
// untouched — pure mappers in `map.ts` adapt each into this shape.

export type AttentionSource = 'signal' | 'recommendation';
export type AttentionSeverity = 'red' | 'yellow' | 'green';

export interface AttentionAction {
  /** InboxActionKind values (signals) + recommendation action kinds. */
  kind: string;
  label: string;
  /** Link-style actions (view-logs / improve-prompt / edit-agent / recent-run) navigate. */
  href?: string;
  /** merge / resolve-conflicts target. */
  prNumber?: number;
  /** Recommendation handler-actions carry the row id the per-project route needs. */
  recommendationId?: string;
  /** e.g. the target schedule string for "Decrease rate". */
  payloadArg?: string;
}

export interface AttentionItem {
  /** `signal:<inboxId>` | `rec:<recId>` — namespaced so the two id-spaces never collide. */
  id: string;
  source: AttentionSource;
  project: string;
  severity: AttentionSeverity;
  title: string;
  detail: string | null;
  ageSeconds: number | null;
  href: string;
  externalUrl: string | null;
  /** One action for a signal; the type/payload-derived set for a recommendation. */
  actions: AttentionAction[];
  /** Set only for recommendations. */
  agent: { id: string; name: string | null } | null;
  /** Recommendations can be dismissed; signals self-clear, so false. */
  dismissible: boolean;
}

export interface AttentionCounts {
  red: number;
  yellow: number;
  green: number;
  total: number;
}
