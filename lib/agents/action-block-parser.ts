// Extract and validate the agent-emitted action block from a run's final
// assistant text. Pairs with `action-schema.ts` (the contract) and
// `action-orchestrator.ts` (the dispatcher).
//
// Grammar (must match what the issue-cruncher prompt tells the agent to emit):
//
//   ```tamtam-actions
//   { "actions": [ ... ] }
//   ```
//
// Multiple blocks → parse failure (ambiguous intent — refuse to act on a
// non-deterministic choice). No block → `missing` (silent no-op; the
// orchestrator skips agents that don't emit one).

import { validateAgentActions, type AgentActionList } from '@/lib/agents/action-schema';

const FENCE_RE = /```tamtam-actions\s*\n([\s\S]*?)\n```/g;

export type ExtractResult =
  | { ok: true; raw: string }
  | { ok: false; reason: 'missing' | 'multiple' };

export function extractActionBlock(assistantText: string): ExtractResult {
  if (typeof assistantText !== 'string' || !assistantText.length) {
    return { ok: false, reason: 'missing' };
  }
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  // Reset before iteration: the regex is module-scope with the /g flag.
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(assistantText)) !== null) {
    matches.push(m[1]);
    if (matches.length > 1) break;
  }
  if (matches.length === 0) return { ok: false, reason: 'missing' };
  if (matches.length > 1) return { ok: false, reason: 'multiple' };
  return { ok: true, raw: matches[0] };
}

export type ParseResult =
  | { ok: true; actions: AgentActionList }
  | { ok: false; reason: 'missing' | 'multiple' | 'invalid-json' | 'invalid-schema'; detail?: string };

export function parseAgentActions(assistantText: string): ParseResult {
  const extracted = extractActionBlock(assistantText);
  if (!extracted.ok) return extracted;

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.raw);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid-json',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const validated = validateAgentActions(parsed);
  if (!validated.ok) {
    return {
      ok: false,
      reason: 'invalid-schema',
      detail: validated.detail,
    };
  }
  return { ok: true, actions: validated.value.actions };
}
