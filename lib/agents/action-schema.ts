// Typed action contract emitted by agents that need to perform write-side
// operations (close issue, comment, label, edit body, switch branch). The
// agent serializes a single block of this shape inside a `tamtam-actions`
// fenced code block as the LAST element of its final assistant message;
// `lib/agents/action-block-parser.ts` extracts it and
// `lib/agents/action-orchestrator.ts` dispatches each entry to the matching
// server-side helper.
//
// Why a structured schema (not free-form markers like `ISSUE_CLOSED <n>`):
// the agent runs inside Codex's `workspace-write` sandbox which blocks all
// localhost traffic. A direct `curl http://localhost:1337/...` from the
// agent always fails with `Operation not permitted`. Emitting structured
// output in the response itself keeps the contract self-contained and
// diagnosable — humans reading the log see the same block tamtam parses.
//
// Validation is hand-rolled (no zod dep) — the schema is small enough that
// adding a new runtime dep per CLAUDE.md guidance is unwarranted.

export type IssueCloseAction = {
  type: 'issue-close';
  number: number;
  reason: 'completed' | 'not planned';
  comment?: string;
};

export type IssueCommentAction = {
  type: 'issue-comment';
  number: number;
  body: string;
};

export type IssueLabelAction = {
  type: 'issue-label';
  number: number;
  addLabels: string[];
  removeLabels: string[];
};

export type IssueEditBodyAction = {
  type: 'issue-edit-body';
  kind: 'issue' | 'pr';
  number: number;
  body: string;
};

export type CheckoutDefaultAction = {
  type: 'checkout-default';
};

// Merge an existing open PR that already implements the picked issue. `issue`
// bounds the action to the cruncher's chosen issue (eligibility check); the
// merge itself is gated by GitHub branch protection / required checks — a red
// or unmergeable PR is refused, never force-merged.
export type MergePrAction = {
  type: 'merge-pr';
  prNumber: number;
  issue: number;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
};

export type AgentAction =
  | IssueCloseAction
  | IssueCommentAction
  | IssueLabelAction
  | IssueEditBodyAction
  | CheckoutDefaultAction
  | MergePrAction;

export type AgentActions = { actions: AgentAction[] };
export type AgentActionList = AgentActions['actions'];

export type ValidationResult =
  | { ok: true; value: AgentActions }
  | { ok: false; detail: string };

/** Validate a parsed JSON value against the agent-action schema. Returns a
 *  list of all problems (joined by `; `) rather than failing on the first
 *  so the caller surfaces actionable feedback when the agent's emit is
 *  malformed. */
export function validateAgentActions(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, detail: 'root must be an object' };
  }
  const actionsRaw = (input as { actions?: unknown }).actions;
  if (!Array.isArray(actionsRaw)) {
    return { ok: false, detail: 'actions must be an array' };
  }
  const out: AgentAction[] = [];
  for (let i = 0; i < actionsRaw.length; i++) {
    const r = validateOneAction(actionsRaw[i], i);
    if (r.ok) {
      out.push(r.value);
    } else {
      errors.push(r.detail);
    }
  }
  if (errors.length) return { ok: false, detail: errors.join('; ') };
  return { ok: true, value: { actions: out } };
}

function validateOneAction(raw: unknown, idx: number): { ok: true; value: AgentAction } | { ok: false; detail: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, detail: `actions[${idx}] must be an object` };
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string') {
    return { ok: false, detail: `actions[${idx}].type must be a string` };
  }
  switch (type) {
    case 'issue-close': {
      const number = numberOrError(obj.number, idx, 'number');
      if ('error' in number) return { ok: false, detail: number.error };
      const reason = obj.reason;
      if (reason !== 'completed' && reason !== 'not planned') {
        return { ok: false, detail: `actions[${idx}].reason must be "completed" or "not planned"` };
      }
      const comment = obj.comment;
      if (comment !== undefined && (typeof comment !== 'string' || !comment.trim())) {
        return { ok: false, detail: `actions[${idx}].comment must be a non-empty string when present` };
      }
      return {
        ok: true,
        value: {
          type: 'issue-close',
          number: number.value,
          reason,
          ...(typeof comment === 'string' ? { comment } : {}),
        },
      };
    }
    case 'issue-comment': {
      const number = numberOrError(obj.number, idx, 'number');
      if ('error' in number) return { ok: false, detail: number.error };
      const body = obj.body;
      if (typeof body !== 'string' || !body.length) {
        return { ok: false, detail: `actions[${idx}].body must be a non-empty string` };
      }
      return { ok: true, value: { type: 'issue-comment', number: number.value, body } };
    }
    case 'issue-label': {
      const number = numberOrError(obj.number, idx, 'number');
      if ('error' in number) return { ok: false, detail: number.error };
      const addLabels = stringArrayOrEmpty(obj.addLabels);
      const removeLabels = stringArrayOrEmpty(obj.removeLabels);
      return { ok: true, value: { type: 'issue-label', number: number.value, addLabels, removeLabels } };
    }
    case 'issue-edit-body': {
      const number = numberOrError(obj.number, idx, 'number');
      if ('error' in number) return { ok: false, detail: number.error };
      const kind = obj.kind;
      if (kind !== 'issue' && kind !== 'pr') {
        return { ok: false, detail: `actions[${idx}].kind must be "issue" or "pr"` };
      }
      const body = obj.body;
      if (typeof body !== 'string') {
        return { ok: false, detail: `actions[${idx}].body must be a string` };
      }
      return { ok: true, value: { type: 'issue-edit-body', kind, number: number.value, body } };
    }
    case 'checkout-default': {
      return { ok: true, value: { type: 'checkout-default' } };
    }
    case 'merge-pr': {
      const prNumber = numberOrError(obj.prNumber, idx, 'prNumber');
      if ('error' in prNumber) return { ok: false, detail: prNumber.error };
      const issue = numberOrError(obj.issue, idx, 'issue');
      if ('error' in issue) return { ok: false, detail: issue.error };
      const method = obj.mergeMethod;
      if (method !== undefined && method !== 'merge' && method !== 'squash' && method !== 'rebase') {
        return { ok: false, detail: `actions[${idx}].mergeMethod must be "merge", "squash", or "rebase"` };
      }
      return {
        ok: true,
        value: {
          type: 'merge-pr',
          prNumber: prNumber.value,
          issue: issue.value,
          ...(typeof method === 'string' ? { mergeMethod: method } : {}),
        },
      };
    }
    default:
      return { ok: false, detail: `actions[${idx}].type unknown: ${type}` };
  }
}

function numberOrError(raw: unknown, idx: number, field: string): { value: number } | { error: string } {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    return { error: `actions[${idx}].${field} must be a positive integer` };
  }
  return { value: raw };
}

function stringArrayOrEmpty(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Human-readable schema rendering for inclusion in agent prompts. The
 *  agent reads this block and emits values matching the shape. Keep in
 *  sync with the type definitions above — `validateAgentActions` will
 *  reject any field shape that drifts.
 */
export const AGENT_ACTIONS_TS_TYPE = `
type AgentActions = { actions: AgentAction[] };

type AgentAction =
  | { type: "issue-close";     number: number; reason: "completed" | "not planned"; comment?: string }
  | { type: "issue-comment";   number: number; body: string }
  | { type: "issue-label";     number: number; addLabels?: string[]; removeLabels?: string[] }
  | { type: "issue-edit-body"; kind: "issue" | "pr"; number: number; body: string }
  | { type: "checkout-default" }
  | { type: "merge-pr"; prNumber: number; issue: number; mergeMethod?: "merge" | "squash" | "rebase" };
`.trim();
