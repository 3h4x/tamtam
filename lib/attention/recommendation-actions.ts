// Pure derivation of a recommendation's available actions, extracted verbatim
// from the conditions in `components/recommendations/RecommendationCard.tsx`
// (:162-207). The card's `onX` prop-presence gates collapse here because the
// unified feed wires every handler, so an action is present iff its rec-derived
// condition holds. Returns AttentionActions the row renders as a Fix ▾ menu.

import type { RecommendationRow } from '@/lib/recommendations/recommendations';
import { AUTO_APPLICABLE_RECOMMENDATION_TYPES, isManualRecommendation } from '@/lib/recommendations/classification';
import { recommendationBackoffSchedule } from '@/lib/recommendations/backoff-schedule';
import type { AttentionAction } from '@/lib/attention/types';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function payloadBoolean(payload: RecommendationRow['payload'], key: string): boolean | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'boolean' ? v : null;
}
function recommendationSourceJobId(payload: RecommendationRow['payload']): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const top = str(p.sourceJobId);
  if (top) return top;
  const reasoning = p.reasoning;
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    return str((reasoning as Record<string, unknown>).sourceJobId);
  }
  return null;
}
function recommendationRecentRunId(rec: RecommendationRow): string | null {
  const payload = rec.payload;
  if (payload && typeof payload === 'object') {
    const runIds = (payload as Record<string, unknown>).runIds;
    if (Array.isArray(runIds)) {
      const first = runIds.find((r): r is string => typeof r === 'string' && r.trim().length > 0);
      if (first) return first;
    }
  }
  return recommendationSourceJobId(payload) ?? rec.source_id;
}
function isUserEditableAgentId(agentId: string | null): boolean {
  return agentId !== null && !agentId.startsWith('system:');
}
const termHref = (project: string, job: string) =>
  `/project/${encodeURIComponent(project)}/terminal?job=${encodeURIComponent(job)}`;
// A terminal deep-link that PRE-FILLS a starter prompt (no auto-submit — see the
// `?draft=` handling in TerminalTab) so the operator lands ready to edit/send.
const termDraftHref = (project: string, draft: string) =>
  `/project/${encodeURIComponent(project)}/terminal?draft=${encodeURIComponent(draft)}`;

// A health finding (`app_health`, from the read-only health monitor) is not an
// agent-quality recommendation — the operator's next move is to SEE what the
// monitor found and then act on the app, not to tune the monitor. So it gets its
// own two navigation actions instead of the generic Fix menu: "Show details →"
// (the health run's full output) and "Open terminal →" (a fresh terminal
// pre-filled with the problem, ready to prompt a fix). Both are nav links, so
// the row renders them inline rather than in a Fix ▾ dropdown.
function appHealthActions(rec: RecommendationRow): AttentionAction[] {
  const out: AttentionAction[] = [];
  const payload = (rec.payload && typeof rec.payload === 'object' ? rec.payload : {}) as Record<string, unknown>;
  const jobId = recommendationSourceJobId(rec.payload) ?? rec.source_id;
  if (jobId) out.push({ kind: 'view-logs', label: 'Show details →', href: termHref(rec.project, jobId) });
  const verdict = str(payload.verdict) ?? 'DEGRADED';
  // Trim trailing sentence punctuation so the appended ". Investigate…" reads
  // cleanly (a reason that already ends in "." must not produce "logs.. Invest…").
  const reason = (str(payload.reason) ?? str(rec.detail) ?? '').replace(/[.\s]+$/, '');
  const draft =
    `The health monitor reports the ${rec.project} app is ${verdict}` +
    (reason ? `: ${reason}` : '') +
    '. Investigate the root cause from the deploy/logs and propose a concrete fix. ' +
    'Confirm the diagnosis before changing anything.';
  out.push({ kind: 'open-terminal', label: 'Open terminal →', href: termDraftHref(rec.project, draft) });
  out.push({ kind: 'dismiss', label: 'Dismiss', recommendationId: rec.id });
  return out;
}

export function recommendationActions(rec: RecommendationRow): AttentionAction[] {
  if (rec.type === 'app_health') return appHealthActions(rec);

  const out: AttentionAction[] = [];
  const rid = rec.id;
  const showFixMenu = Boolean(rec.agent_id) && isManualRecommendation(rec.type);

  if (showFixMenu) {
    const enabled = payloadBoolean(rec.payload, 'enabled');
    const boostable = payloadBoolean(rec.payload, 'boostable');
    const editableAgent = isUserEditableAgentId(rec.agent_id);
    const actionable = editableAgent && enabled !== false;
    const recentRunId = recommendationRecentRunId(rec);
    const sourceJobId = recommendationSourceJobId(rec.payload);
    const backoff = recommendationBackoffSchedule(rec);
    const editHref = rec.agent_id
      ? `/project/${encodeURIComponent(rec.project)}/agents?agent=${encodeURIComponent(rec.agent_id)}`
      : null;
    const cause = str((rec.payload as Record<string, unknown> | null)?.cause);
    const promptFix =
      (rec.type === 'agent_unfruitful' && cause !== 'idle') || rec.type === 'orchestrator_agent_health';

    if (AUTO_APPLICABLE_RECOMMENDATION_TYPES.has(rec.type)) {
      out.push({ kind: 'apply', label: 'Apply suggested change', recommendationId: rid });
    }
    if (enabled !== false) out.push({ kind: 'run-now', label: 'Run agent now', recommendationId: rid });
    if (sourceJobId && sourceJobId !== recentRunId) {
      out.push({ kind: 'view-logs', label: 'View logs →', href: termHref(rec.project, sourceJobId) });
    }
    if (actionable) out.push({ kind: 'investigate', label: 'Run investigation', recommendationId: rid });
    if (backoff && actionable) {
      out.push({ kind: 'decrease-rate', label: 'Decrease rate', recommendationId: rid, payloadArg: backoff });
    }
    if (actionable && boostable !== false) {
      out.push({ kind: 'stop-boosting', label: 'Stop boosting', recommendationId: rid });
    }
    if (actionable) out.push({ kind: 'disable', label: 'Disable agent', recommendationId: rid });
    if (editHref && editableAgent && promptFix) {
      out.push({ kind: 'improve-prompt', label: 'Improve prompt', href: `${editHref}&improve=1` });
    }
    if (editHref) out.push({ kind: 'edit-agent', label: 'Edit agent…', href: editHref });
  } else if (AUTO_APPLICABLE_RECOMMENDATION_TYPES.has(rec.type)) {
    out.push({ kind: 'apply', label: 'Apply suggested change', recommendationId: rid });
  }

  out.push({ kind: 'dismiss', label: 'Dismiss', recommendationId: rid });
  return out;
}
